'use strict'

const AWS = require('aws-sdk')
const { createAWSConnection, awsCredsifyAll } = require('@acuris/aws-es-connection')
const elasticsearch = require('@elastic/elasticsearch')
const through2 = require('through2')
const ElasticsearchWritableStream = require('./ElasticSearchWriteableStream')
const logger = console //require('./logger')
const collections_mapping = require('../fixtures/collections.js')()
const items_mapping = require('../fixtures/items.js')()

const COLLECTIONS_INDEX = process.env.COLLECTIONS_INDEX || 'collections'
const ITEMS_INDEX = process.env.ITEMS_INDEX || 'items'

let _esClient
/*
This module is used for connecting to an Elasticsearch instance, writing records,
searching records, and managing the indexes. It looks for the ES_HOST environment
variable which is the URL to the elasticsearch host
*/

// Connect to an Elasticsearch instance
async function connect() {
  let esConfig
  let client

  // use local client
  if (!process.env.ES_HOST) {
    esConfig = {
      node: 'localhost:9200'
    }
    client = new elasticsearch.Client(esConfig)
  } else {
    //const awsCredentials = await awsGetCredentials()
    const AWSConnector = createAWSConnection(AWS.config.credentials)
    client = awsCredsifyAll(
      new elasticsearch.Client({
        node: `https://${process.env.ES_HOST}`,
        Connection: AWSConnector
      })
    )
  }

  const health = await client.cat.health()
  logger.debug(`Health: ${JSON.stringify(health)}`)

  return client
}

// get existing ES client or create a new one
async function esClient() {
  if (!_esClient) {
    try {
      _esClient = await connect()
    } catch (error) {
      logger.error(error)
    }
    if (_esClient) {
      logger.debug('Connected to Elasticsearch')
    }
  } else {
    logger.debug('Using existing Elasticsearch connection')
  }
  return _esClient
}


async function create_index(index) {
  const client = await esClient()
  const exists = await client.indices.exits({ index })
  const mapping = (index === 'collections' ? collections_mapping : items_mapping)
  if (!exists) {
    try {
      await client.indices.create({ index: COLLECTIONS_INDEX, body: mapping })
      logger.info(`Created index ${index}`)
      logger.debug(`Mapping: ${JSON.stringify(mapping)}`)
    } catch (error) {
      const debugMessage = `Error creating index ${index}, already created: ${error}`
      logger.debug(debugMessage)
    }
  }
}


// Given an input stream and a transform, write records to an elasticsearch instance
async function _stream() {
  let esStreams
  try {
    const client = await esClient()

    const toEs = through2.obj({ objectMode: true }, (data, encoding, next) => {
      let index = ''
      if (data && data.hasOwnProperty('extent')) {
        index = COLLECTIONS_INDEX
      } else if (data && data.hasOwnProperty('geometry')) {
        index = ITEMS_INDEX
        if (!client.indices.exists(index)) {
          throw new Error(`Collection ${index} does not exist, add before ingesting items`)
        }
      } else {
        next()
        return
      }

      // remove any hierarchy links in a non-mutating way
      const hlinks = ['self', 'root', 'parent', 'child', 'collection', 'item']
      const links = data.links.filter((link) => !hlinks.includes(link.rel))
      const esDataObject = Object.assign({}, data, { links })

      // create ES record
      const record = {
        index,
        type: 'doc',
        id: esDataObject.id,
        action: 'update',
        _retry_on_conflict: 3,
        body: {
          doc: esDataObject,
          doc_as_upsert: true
        }
      }
      next(null, record)
    })
    const esStream = new ElasticsearchWritableStream({ client: client }, {
      objectMode: true,
      highWaterMark: Number(process.env.ES_BATCH_SIZE) || 500
    })
    esStreams = { toEs, esStream }
  } catch (error) {
    logger.error(error)
  }
  return esStreams
}

function buildRangeQuery(property, operators, operatorsObject) {
  const gt = 'gt'
  const lt = 'lt'
  const gte = 'gte'
  const lte = 'lte'
  const comparisons = [gt, lt, gte, lte]
  let rangeQuery
  if (operators.includes(gt) || operators.includes(lt) ||
         operators.includes(gte) || operators.includes(lte)) {
    const propertyKey = `properties.${property}`
    rangeQuery = {
      range: {
        [propertyKey]: {
        }
      }
    }
    // All operators for a property go in a single range query.
    comparisons.forEach((comparison) => {
      if (operators.includes(comparison)) {
        const exisiting = rangeQuery.range[propertyKey]
        rangeQuery.range[propertyKey] = Object.assign({}, exisiting, {
          [comparison]: operatorsObject[comparison]
        })
      }
    })
  }
  return rangeQuery
}

function buildDatetimeQuery(parameters) {
  let dateQuery
  const { datetime } = parameters
  if (datetime) {
    const dataRange = datetime.split('/')
    if (dataRange.length === 2) {
      dateQuery = {
        range: {
          'properties.datetime': {
            gte: dataRange[0],
            lte: dataRange[1]
          }
        }
      }
    } else {
      dateQuery = {
        term: {
          'properties.datetime': datetime
        }
      }
    }
  }
  return dateQuery
}

function buildQuery(parameters) {
  const eq = 'eq'
  const inop = 'in'
  const { query, intersects, collections } = parameters
  let must = []
  if (query) {
    // Using reduce rather than map as we don't currently support all
    // stac query operators.
    must = Object.keys(query).reduce((accumulator, property) => {
      const operatorsObject = query[property]
      const operators = Object.keys(operatorsObject)
      if (operators.includes(eq)) {
        const termQuery = {
          term: {
            [`properties.${property}`]: operatorsObject.eq
          }
        }
        accumulator.push(termQuery)
      } else if (operators.includes(inop)) {
        const termsQuery = {
          terms: {
            [`properties.${property}`]: operatorsObject.in
          }
        }
        accumulator.push(termsQuery)
      }
      const rangeQuery =
        buildRangeQuery(property, operators, operatorsObject)
      if (rangeQuery) {
        accumulator.push(rangeQuery)
      }
      return accumulator
    }, must)
  }

  if (collections) {
    must.push({
      terms: {
        'collection': collections
      }
    })
  }

  if (intersects) {
    must.push({
      geo_shape: {
        geometry: { shape: intersects }
      }
    })
  }

  const datetimeQuery = buildDatetimeQuery(parameters)
  if (datetimeQuery) {
    must.push(datetimeQuery)
  }

  const filter = { bool: { must } }
  const queryBody = {
    constant_score: { filter }
  }
  return { query: queryBody }
}

function buildIdQuery(id) {
  return {
    query: {
      constant_score: {
        filter: {
          term: {
            id
          }
        }
      }
    }
  }
}

function buildIdsQuery(ids) {
  return {
    query: {
      ids: {
        values: ids
      }
    }
  }
}


function buildSort(parameters) {
  const { sortby } = parameters
  let sorting
  if (sortby && sortby.length > 0) {
    sorting = sortby.map((sortRule) => {
      const { field, direction } = sortRule
      return {
        [field]: {
          order: direction
        }
      }
    })
  } else {
    // Default item sorting
    sorting = [
      { 'properties.datetime': { order: 'desc' } }
    ]
  }
  return sorting
}


function buildFieldsFilter(parameters) {
  const { fields } = parameters
  let _sourceIncludes = []
  if (parameters.hasOwnProperty('fields')) {
    // if fields parameters supplied at all, start with this initial set, otherwise return all
    _sourceIncludes = [
      'id',
      'type',
      'geometry',
      'bbox',
      'links',
      'assets',
      'collection',
      'properties.datetime'
    ]
  }
  let _sourceExcludes = []
  if (fields) {
    const { include, exclude } = fields
    // Add include fields to the source include list if they're not already in it
    if (include && include.length > 0) {
      include.forEach((field) => {
        if (_sourceIncludes.indexOf(field) < 0) {
          _sourceIncludes.push(field)
        }
      })
    }
    // Remove exclude fields from the default include list and add them to the source exclude list
    if (exclude && exclude.length > 0) {
      _sourceIncludes = _sourceIncludes.filter((field) => !exclude.includes(field))
      _sourceExcludes = exclude
    }
  }
  return { _sourceIncludes, _sourceExcludes }
}

/*
 * Part of the Transaction extension https://github.com/radiantearth/stac-api-spec/tree/master/extensions/transaction
 *
 * This conforms to a PATCH request and updates an existing item by ID
 * using a partial item description, compliant with RFC 7386.
 *
 * PUT should be implemented separately and is TODO.
 */
async function editPartialItem(itemId, updateFields) {
  const client = await esClient()
  
  // Handle inserting required default properties to `updateFields`
  const requiredProperties = {
    updated: new Date().toISOString()
  }

  if (updateFields.properties) {
    // If there are properties incoming, merge and overwrite
    // our required ones.
    Object.assign(updateFields.properties, requiredProperties)
  } else {
    updateFields.properties = requiredProperties
  }

  const response = await client.update({
    index: ITEMS_INDEX,
    id: itemId,
    type: 'doc',
    _source: true,
    body: {
      doc: updateFields
    }
  })
  return response
}


async function search(parameters, index = '*', page = 1, limit = 10) {
  let body
  if (parameters.ids) {
    const { ids } = parameters
    body = buildIdsQuery(ids)
  } else if (parameters.id) {
    const { id } = parameters
    body = buildIdQuery(id)
  } else {
    body = buildQuery(parameters)
  }
  const sort = buildSort(parameters)
  body.sort = sort

  const searchParams = {
    index,
    body,
    size: limit,
    from: (page - 1) * limit
  }

  // disable fields filter for now
  const { _sourceIncludes, _sourceExcludes } = buildFieldsFilter(parameters)
  if (_sourceExcludes.length > 0) {
    searchParams._sourceExcludes = _sourceExcludes
  }
  if (_sourceIncludes.length > 0) {
    searchParams._sourceIncludes = _sourceIncludes
  }

  logger.info(`Elasticsearch query: ${JSON.stringify(searchParams)}`)

  const client = await esClient()
  const esResponse = await client.search(searchParams)
  logger.debug(`Result: ${JSON.stringify(esResponse)}`)

  const results = esResponse.body.hits.hits.map((r) => (r._source))
  const response = {
    results,
    context: {
      page: Number(page),
      limit: Number(limit),
      matched: esResponse.body.hits.total,
      returned: results.length
    },
    links: []
  }
  const nextlink = (((page * limit) < esResponse.body.hits.total) ? page + 1 : null)
  if (nextlink) {
    response.links.push({
      title: 'next',
      type: 'application/json',
      href: nextlink
      // TODO - add link to next page
    })
  }
  return response
}

module.exports = {
  stream: _stream,
  search,
  editPartialItem,
  create_index
}
