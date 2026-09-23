export async function findFreePort(net: typeof import('net')): Promise<number> {
  const server = net.createServer()

  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to resolve allocated port')))
        return
      }

      const { port } = address
      server.close((error?: Error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })
}
