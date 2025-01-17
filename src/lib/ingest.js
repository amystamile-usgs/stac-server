import { Readable } from 'readable-stream'
import pump from 'pump'
import logger from './logger.js'

export async function ingestItem(item, stream) {
  const readable = new Readable({ objectMode: true })
  const { toDB, dbStream } = await stream()
  const promise = new Promise((resolve, reject) => {
    pump(
      readable,
      toDB,
      dbStream,
      (error) => {
        if (error) {
          logger.error('Error ingesting', error)
          reject(error)
        } else {
          logger.info(`Ingested item ${item.id}`)
          resolve(true)
        }
      }
    )
  })
  readable.push(item)
  readable.push(null)
  return promise
}

export async function ingestItems(items, stream) {
  const readable = new Readable({ objectMode: true })
  const { toDB, dbStream } = await stream()
  const promise = new Promise((resolve, reject) => {
    pump(
      readable,
      toDB,
      dbStream,
      (error) => {
        if (error) {
          logger.error('Error ingesting', error)
          reject(error)
        } else {
          logger.debug('Ingested item')
          resolve(true)
        }
      }
    )
  })
  items.forEach((item) => readable.push(item))
  readable.push(null)
  return promise
}
