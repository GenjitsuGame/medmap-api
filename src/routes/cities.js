import config from 'config';
import { Router } from 'express';
import _ from 'lodash';
import Promise from 'bluebird';
import Busboy from 'busboy';
import { elasticsearch, mongo, redis } from '../database';
import { snowflake } from '../helpers';
import { dynamodbLogger, mongoLogger, serverLogger } from '../loggers';

const router = Router();
router
  .route('/')
  .get((req, res, next) => {
    (async () => {
      const query = req.query.q;
      const speciality = req.query.speciality;
      const department = req.query.department;
      const economicOrientation = req.query.economic_orientation;
      const hasPharmacy = req.query.has_pharmacy;
      const medicalDensity = req.query.medical_density;
      const demographicEvolution = req.query.demographic_evolution;
      const limit = req.query.limit;

      let esResults;
      if (query) {
        esResults = await elasticsearch.search({
          index: config.elasticsearch.index,
          type: 'record',
          body: {
            query: {
              multi_match: {
                type: 'phrase_prefix',
                fields: ['nom_com'],
                query: query
              }
            },
            size: 1000
          }
        });

        return res.json({
          data: await mongo.models.City.find({
            n_id: {
              $in: esResults.hits.hits.map(record => record._id)
            }
          })
        });
      }

      const params = {};
      //if (speciality);
      if (department) params.dep = Number(department);
      if (economicOrientation) params.orientation_economique = economicOrientation
      if (hasPharmacy) params.nb_pharmacies_et_parfumerie = {
        $exists: hasPharmacy
      }
      if (demographicEvolution === 'Augmentation') {
        params.evolution_population = {
          $gte: 0
        };
      } else if (demographicEvolution === 'Diminution') {
        params.evolution_population = {
          $lt: 0
        };
      }

      return res.json({
        data: await  mongo.models.City.find(params).sort({ densité_médicale_bv: medicalDensity === 'Faible' ? 1 : -1 }).limit(limit || 10).exec()
      });


    })().catch(next);
  })
  .post((req, res, next) => {
    const busboy = new Busboy({ headers: req.headers });
    let records = '';
    busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
      console.log('File [' + fieldname + ']: filename: ' + filename + ', encoding: ' + encoding + ', mimetype: ' + mimetype);

      file.on('data', function (data) {
        records += data;
      });
      file.on('end', async function () {
        const jobId = await snowflake.getId();
        redis.set(jobId, true);
        records = JSON.parse(records);

        for (let record of records) {
          record.id = await snowflake.getId();
        }

        records = records.map(record => {
          const formattedRecord = {};
          Object.keys(record).forEach(key => {
            if (record[key])
              formattedRecord[key.replace(/\s/g, '_').toLowerCase()] = record[key];
          });
          return formattedRecord;
        });

        // const indexToDynamo = rawIndexToDynamo(records)
        //   .catch(console.log.bind(console));

        const indexToMongo = Promise
          .each(_.chunk(records.map(record => {
            const newRecord = Object.assign({}, record);
            newRecord.n_id = record.id;
            delete newRecord.id;
            return newRecord;
          }), 1000), items => {
            return mongo.models.City.insertMany(items)
              .catch(mongoLogger.error);
          })
          .catch(serverLogger.error);


        const indexToElastic = Promise
          .each(_.chunk(records, 1000)
            .map(chunk => {
              return chunk.reduce((prev, curr) => {
                prev.push({
                  index: {
                    _index: config.elasticsearch.index,
                    _type: 'record',
                    _id: curr.id
                  }
                });

                prev.push({
                  insee_code: curr.codgeo,
                  nom_com: curr.nom_com || curr.libgeo,
                  nom_dept: curr.nom_dept,
                  nom_reg: curr.nom_reg,
                  geo_point: curr.geo_point,
                  geo_shape: curr.geo_shape
                })
                return prev;
              }, []);
            }), items => {
            return elasticsearch
              .bulk({
                body: items
              });
          })
          .catch(serverLogger.error);

        await indexToMongo;
        // await indexToDynamo;
        await indexToElastic;
        serverLogger.info('Done indexing city records.');
        redis.del(jobId)
      });
    });
    req.pipe(busboy);

    return res.json({ message: 'job started (will be replaced with jobId).' });
  });

function rawIndexToDynamo(records) {
  serverLogger.info(`processing ${records.length} records.`);
  const unprocessedItems = [];
  return Promise
    .each(_.chunk(records.map(record => {
      const dynamoRecord = {}
      for (let key of Object.keys(record)) {
        dynamoRecord[key] = {
          S: record[key]
        }
      }

      return {
        PutRequest: {
          Item: dynamoRecord
        }
      };
    }), 25), items => {
      return writeBatch(items)
        .then(response => {
          dynamodbLogger.info(response);
          if (response.UnprocessedItems.string) {
            for (let unprocessedItem of response.UnprocessedItems.string) {
              unprocessedItems.push(unprocessedItem);
            }
          }
          return Promise.delay(1000);
        });
    })
    .then(() => {
      if (unprocessedItems.length) return formattedIndexToDynamo(unprocessedItems);
    });
}

function formattedIndexToDynamo(records) {
  serverLogger.info(`processing ${records.length} records.`);
  const unprocessedItems = [];
  return Promise
    .each(_.chunk(records, 25), items => {
      return writeBatch(items)
        .then(response => {
          dynamodbLogger.info(response);
          for (let unprocessedItem of response.UnprocessedItems.string) {
            unprocessedItems.push(unprocessedItem);
          }
          return Promise.delay(2000);
        });
    })
    .then(() => {
      if (unprocessedItems.length) return formattedIndexToDynamo(unprocessedItems);
    });
}

function writeBatch(items) {
  const params = {
    RequestItems: {},
    ReturnItemCollectionMetrics: 'SIZE'
  };
  params.RequestItems[config.dynamodb.tableName] = items
  return dynamodb
    .batchWriteItemAsync(params)
}


export default router;
