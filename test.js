const Nightmare = require('nightmare');

Nightmare.action(
  'fastGoto',
  (name, options, parent, win, renderer, done) => {
    const KNOWN_PROTOCOLS = ['http', 'https', 'file', 'about', 'javascript']
    const urlFormat = require('url')
    // 没办法源码用了Symbol，只能用野路子遍历出来
    let ss = Object.getOwnPropertySymbols(win)
    let IS_READY = undefined
    let found = false
    for (let i in ss) {
      if (String(ss[i]) == 'Symbol(isReady)') {
        IS_READY = ss[i]
      }
    }
    parent.respondTo('fastGoto', function(url, headers, timeout, done) {
      if (!url || typeof url !== 'string') {
        return done(new Error('goto: `url` must be a non-empty string'))
      }

      var httpReferrer = ''
      var extraHeaders = ''
      for (var key in headers) {
        if (key.toLowerCase() == 'referer') {
          httpReferrer = headers[key]
          continue
        }

        extraHeaders += key + ': ' + headers[key] + '\n'
      }
      var loadUrlOptions = { extraHeaders: extraHeaders }
      httpReferrer && (loadUrlOptions.httpReferrer = httpReferrer)

      if (win.webContents.getURL() == url) {
        done()
      } else {
        var responseData = {}
        var domLoaded = false

        var timer = setTimeout(function() {
          // If the DOM loaded before timing out, consider the load successful.
          var error = domLoaded
            ? undefined
            : {
                message: 'navigation error',
                code: -7, // chromium's generic networking timeout code
                details: `Navigation timed out after ${timeout} ms`,
                url: url
              }
          // Even if "successful," note that some things didn't finish.
          responseData.details = `Not all resources loaded after ${timeout} ms`
          cleanup(error, responseData)
        }, timeout)

        function handleFailure(event, code, detail, failedUrl, isMainFrame) {
          if (isMainFrame) {
            cleanup({
              message: 'navigation error',
              code: code,
              details: detail,
              url: failedUrl || url
            })
          }
        }

        function handleDetails(
          event,
          status,
          newUrl,
          oldUrl,
          statusCode,
          method,
          referrer,
          headers,
          resourceType
        ) {
          if (resourceType === 'mainFrame') {
            responseData = {
              url: newUrl,
              code: statusCode,
              method: method,
              referrer: referrer,
              headers: headers
            }
          }
        }

        function handleDomReady() {
          domLoaded = true
          // edit personal
          handleFinish()
        }

        // We will have already unsubscribed if load failed, so assume success.
        function handleFinish(_event) {
          cleanup(null, responseData)
        }

        function cleanup(err, data) {
          clearTimeout(timer)
          win.webContents.removeListener('did-fail-load', handleFailure)
          win.webContents.removeListener(
            'did-fail-provisional-load',
            handleFailure
          )
          win.webContents.removeListener(
            'did-get-response-details',
            handleDetails
          )
          win.webContents.removeListener('dom-ready', handleDomReady)
          win.webContents.removeListener('did-finish-load', handleFinish)
          setIsReady(true)
          // wait a tick before notifying to resolve race conditions for events
          setImmediate(() => done(err, data))
        }

        function setIsReady(ready) {
          ready = !!ready
          if (ready !== win[IS_READY]) {
            win[IS_READY] = ready
            win.emit('did-change-is-ready', ready)
          }
        }

        // In most environments, loadURL handles this logic for us, but in some
        // it just hangs for unhandled protocols. Mitigate by checking ourselves.
        function canLoadProtocol(protocol, callback) {
          protocol = (protocol || '').replace(/:$/, '')
          if (!protocol || KNOWN_PROTOCOLS.includes(protocol)) {
            return callback(true)
          }
          electron.protocol.isProtocolHandled(protocol, callback)
        }

        function startLoading() {
          // abort any pending loads first
          if (win.webContents.isLoading()) {
            parent.emit('log', 'aborting pending page load')
            win.webContents.once('did-stop-loading', function() {
              startLoading(true)
            })
            return win.webContents.stop()
          }

          win.webContents.on('did-fail-load', handleFailure)
          win.webContents.on('did-fail-provisional-load', handleFailure)
          win.webContents.on('did-get-response-details', handleDetails)
          win.webContents.on('dom-ready', handleDomReady)
          win.webContents.on('did-finish-load', handleFinish)
          win.webContents.loadURL(url, loadUrlOptions)

          // javascript: URLs *may* trigger page loads; wait a bit to see
          if (protocol === 'javascript:') {
            setTimeout(function() {
              if (!win.webContents.isLoadingMainFrame()) {
                done(null, {
                  url: url,
                  code: 200,
                  method: 'GET',
                  referrer: win.webContents.getURL(),
                  headers: {}
                })
              }
            }, 10)
          }
        }

        var protocol = urlFormat.parse(url).protocol
        canLoadProtocol(protocol, function startLoad(canLoad) {
          if (canLoad) {
            parent.emit(
              'log',
              `Navigating: "${url}",
              headers: ${extraHeaders || '[none]'},
              timeout: ${timeout}`
            )
            return startLoading()
          }

          cleanup({
            message: 'navigation error',
            code: -1000,
            details: 'unhandled protocol',
            url: url
          })
        })
      }
    })
    done()
  },
  function(url, done) {
    var self = this

    headers = {}
    for (var key in this._headers) {
      headers[key] = headers[key] || this._headers[key]
    }
    this.child.call('fastGoto', url, headers, this.options.gotoTimeout, done)
  }
)


let nm = Nightmare({
  show: true,
  openDevTools: {
    mode: 'detach'
  },
  // goto和load的超时已经设置的情况下，按理说wait超时只能是页面不对
  waitTimeout: 10 * 1000,
  pollInterval: 250,
  // 如果被同步js或者css卡住则只能等，超时的话，可能页面不正常
  gotoTimeout: 90 * 1000,
  // 如果js css超时，触发loadTimeout，则页面网络全面停止，document.ready和window.onload都不执行
  // 所以此处设置无超时，或者保持和gotoTimeout一致，但是chrome的网络超时大概70s
  // 参考：https://productforums.google.com/forum/#!topic/chrome/PYnhPleNgQw
  loadTimeout: null,
  executionTimeout: 60 * 1000,
  webPreferences: {
    images: true,
    webSecurity: false,
    allowRunningInsecureContent: true
  }
})

let pre = new Date()
let log = (msg)=>{
  let duration = new Date().getTime() - pre.getTime()
  pre = new Date()
  console.log(pre, duration + 'ms', msg)
}


async function run(){
  try{
    log('start')
    await nm.goto('http://local:8000/test.html')
    // await nm.fastGoto('http://local:8000/test.html')
    log('opend')


    let p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)
    p = await nm.evaluate(()=>{
      return document.querySelector('p').innerHTML
    })
    log('evaluate ' + p)


  } catch(e) {
    log(e)
  }
}

run()
