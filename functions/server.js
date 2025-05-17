const server = require('../index')
const { createServer } = require('http')
const serverInstance = createServer(server)

exports.handler = (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false
  return new Promise((resolve) => {
    serverInstance.emit('request', event, event.body)
    serverInstance.on('response', (res) => {
      resolve(res)
    })
  })
}
