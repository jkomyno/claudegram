import { createConnection } from 'node:net'

export const socketIsAlive = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
