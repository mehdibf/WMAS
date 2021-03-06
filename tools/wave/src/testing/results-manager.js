const path = require('path')
const crypto = require('crypto')

const Session = require('../data/session')
const FileSystem = require('../utils/file-system')
const UserAgentParser = require('../utils/user-agent-parser')
const WptReport = require('./wpt-report')

class ResultsManager {
  constructor ({ resultsDirectoryPath, database, sessionManager }) {
    this._resultsDirectoryPath = resultsDirectoryPath
    this._database = database
    this._sessionManager = sessionManager
  }

  async getJsonPath ({ token, api }) {
    const session = await this._sessionManager.getSession(token)
    return this._getFilePath({
      userAgent: session.getUserAgent(),
      api,
      token
    })
  }

  async getJsonPath2 ({ token, api }) {
    const session = await this._sessionManager.getSession(token)
    return {
      inputDir: this._resultsDirectoryPath,
      token,
      api,
      filename: this._getFileName(session.getUserAgent()),
    }
  }

  async getHtmlPath ({ tokens, reftoken, token, api }) {
    let directoryPath = ''
    if (token) {
      directoryPath = token + '/' + api
    } else {
      let hash = crypto.createHash('sha1')
      tokens
        .sort((tokenA, tokenB) => (tokenA > tokenB ? 1 : -1))
        .forEach(token => hash.update(token))

      if (reftoken) {
        // separate reftoken from regular token
        hash.update(',');
        hash.update(reftoken);
      }

      hash = hash.digest('hex')
      const comparisonDirectoryPath = path.join(
        this._resultsDirectoryPath,
        hash
      )

      if (!await FileSystem.exists(comparisonDirectoryPath)) {
        await FileSystem.makeDirectory(comparisonDirectoryPath)
      }

      const apiDirectoryPath = path.join(comparisonDirectoryPath, api)
      if (await FileSystem.exists(apiDirectoryPath)) {
        await FileSystem.removeDirectory(apiDirectoryPath)
      }
      await FileSystem.makeDirectory(apiDirectoryPath)

      const resultJsonFilePaths = await Promise.all(
        tokens.map(token => this.getJsonPath2({ token, api }))
      )
      const referenceDir = reftoken ?
        path.join(this._resultsDirectoryPath, reftoken, api) :
        null
      await WptReport.generateMultiReport({
        outputHtmlDirectoryPath: apiDirectoryPath,
        specName: api,
        resultJsonFilePaths,
        referenceDir
      })

      directoryPath = hash + '/' + api
    }
    return directoryPath + (reftoken ? '/all_filtered.html' : '/all.html')
  }

  async saveResult ({ token, result, test }) {
    const session = await this._sessionManager.getSession(token)
    if (!session) return

    if (!session.testExists(test)) return

    if (!session.isTestComplete(test)) {
      session.completeTest(test)
      await this._database.createResult(token, result)
      const api = test.split('/')[0]
      if (session.isApiComplete(api)) {
        await this.saveApiResults({ token, api })
        await this.generateReport({ token, api })
      }
    }
    await this._sessionManager.updateSession(session)
  }

  async saveApiResults ({ token, api }) {
    const apiResults = { results: (await this.getResults(token))[api] }
    const session = await this._sessionManager.getSession(token)

    await this._ensureResultsDirectoryExistence({ api, token, session })

    const filePath = await this.getJsonPath({ token, api })
    await FileSystem.writeFile(filePath, JSON.stringify(apiResults, null, 2))
  }

  async loadResults () {
    const sessionManager = this._sessionManager
    const resultsDirectoryPath = this._resultsDirectoryPath
    if (!(await FileSystem.exists(resultsDirectoryPath))) return
    const tokens = await FileSystem.readDirectory(resultsDirectoryPath)
    for (let token of tokens) {
      // http://webapitests2017.ctawave.org:8050/?
      //   path=/2dcontext,%20/css,%20/content-security-policy,%20/dom,%20/ecmascript,%20/encrypted-media,%20/fetch,%20/fullscreen,%20/html,%20/IndexedDB,%20/media-source,%20/notifications,%20/uievents,%20/WebCryptoAPI,%20/webaudio,%20/webmessaging,%20/websockets,%20/webstorage,%20/workers,%20/xhr
      //   &reftoken=ce4aec10-7855-11e8-b81b-6714c602f007

      // http://webapitests2017.ctawave.org:8050/?path=/2dcontext,%20/css,%20/content-security-policy,%20/dom,%20/ecmascript,%20/encrypted-media,%20/fetch,%20/fullscreen,%20/html,%20/IndexedDB,%20/media-source,%20/notifications,%20/uievents,%20/WebCryptoAPI,%20/webaudio,%20/webmessaging,%20/websockets,%20/webstorage,%20/workers,%20/xhr
      // &reftoken=01d11810-7938-11e8-8749-a6ac1d216fc7,a831a820-7855-11e8-9ce0-d6175576bb4b,c0cdb6c0-7b99-11e8-939a-90ffd3c0ec6f,ce4aec10-7855-11e8-b81b-6714c602f007
      const resultDirectoryPath = path.join(resultsDirectoryPath, token)
      const infoFilePath = path.join(resultDirectoryPath, 'info.json')
      if (!(await FileSystem.exists(infoFilePath))) continue
      const infoFile = await FileSystem.readFile(infoFilePath)
      const { user_agent: userAgent } = JSON.parse(infoFile)
      const { browser } = UserAgentParser.parse(userAgent)
      if (await sessionManager.getSession(token)) continue
      process.stdout.write(`Loading ${browser.name} ${browser.version} results ...`)
      const session = new Session(token, {status: Session.COMPLETED, userAgent})
      await sessionManager.addSession(session)
      const apis = await FileSystem.readDirectory(resultDirectoryPath)
      for (let api of apis) {
        const apiPath = path.join(resultDirectoryPath, api)
        if (!(await FileSystem.stats(apiPath)).isDirectory()) continue
        const resultsFile = (await FileSystem.readDirectory(apiPath)).find(file => /\w\w\d{1,3}\.json/.test(file))
        const resultsFilePath = path.join(apiPath, resultsFile)
        const { results } = JSON.parse(await FileSystem.readFile(resultsFilePath))
        for (let result of results) {
          await this._database.createResult(token, result)
        }
      }
      process.stdout.write(' done.\n')
    }
  }

  async generateReport ({ token, api }) {
    const filePath = await this.getJsonPath({ token, api })
    const dirPath = path.dirname(filePath)
    await WptReport.generateReport({
      inputJsonDirectoryPath: dirPath,
      outputHtmlDirectoryPath: dirPath,
      specName: api
    })
  }

  async getTokensFromHash(element) {
    let tokens = []
    const tempPath = path.join(this._resultsDirectoryPath, element)
    if (await FileSystem.exists(tempPath)) {
      const tokenUaRegex = /(.+)[-]([a-zA-Z]{2}\d+).json/
      const apiNames = await FileSystem.readDirectory(tempPath)
      const targetFolder = path.join(tempPath, apiNames[0])
      tokens = await FileSystem.readDirectory(targetFolder)
      tokens = tokens.filter( name => {
        return tokenUaRegex.exec(name)
      })
      for (let i = 0; i < tokens.length; i++) {
        tokens[i] = tokens[i].replace(/(-[a-zA-Z]{2}\d+).json/, '')
      }
    }
    return tokens
  }

  async _ensureResultsDirectoryExistence ({ token, api, session }) {
    if (!await FileSystem.stats(this._resultsDirectoryPath)) {
      await FileSystem.makeDirectory(this._resultsDirectoryPath)
    }

    let directory = path.join(this._resultsDirectoryPath, token)
    if (!await FileSystem.stats(directory)) {
      await FileSystem.makeDirectory(directory)
    }

    const infoFilePath = path.join(directory, 'info.json')
    if (!await FileSystem.stats(infoFilePath)) {
      let info = {}
      info.user_agent = session.getUserAgent()
      info.path = session.getPath()
      info.types = session.getTypes()
      await FileSystem.writeFile(infoFilePath, JSON.stringify(info, null, '  '))
    }

    directory = path.join(directory, api)
    if (!await FileSystem.stats(directory)) {
      await FileSystem.makeDirectory(directory)
    }
  }

  _getFilePath ({ userAgent, api, token }) {
    const apiDirectory = path.join(this._resultsDirectoryPath, token, api)
    return path.join(apiDirectory, this._getFileName(userAgent))
  }

  _getFileName (userAgent) {
    const { browser: { name, version } } = UserAgentParser.parse(userAgent)
    const abbreviation = UserAgentParser.abbreviateBrowserName(name)
    return abbreviation + version + '.json'
  }

  async getResults (token) {
    const results = await this._database.getResults(token)
    const resultsPerApi = {}
    results.forEach(result => {
      let api
      if (result.test.startsWith('/')) {
        api = result.test.split('/')[1]
      } else {
        api = result.test.split('/')[0]
      }
      if (!resultsPerApi[api]) resultsPerApi[api] = []
      delete result._id
      resultsPerApi[api].push(result)
    })

    return resultsPerApi
  }

  prepareResult (result) {
    const harness_status_map = {
      0: 'OK',
      1: 'ERROR',
      2: 'TIMEOUT',
      3: 'NOTRUN'
    }
    const subtest_status_map = {
      0: 'PASS',
      1: 'FAIL',
      2: 'TIMEOUT',
      3: 'NOTRUN'
    }

    if (result.tests) {
      result.tests.forEach(test => {
        test.status = subtest_status_map[test.status]
        delete test.stack
      })
      result.subtests = result.tests
      delete result.tests
    }

    delete result.stack
    result.status = harness_status_map[result.status]

    return result
  }
}

module.exports = ResultsManager
