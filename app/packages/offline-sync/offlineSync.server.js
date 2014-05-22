var log = new Logger("offlineSync:server");
Logger.setLevel({log: "trace"});

log.trace("outside in package");

Meteor.startup(function () {
});

var offlineCollections = {};
var collections = {};
var chunkSize = 1000;
var now = moment().unix();

var activeStreams = {};

OfflineSync = {};

OfflineSync.Collection = function (name, options) {
   var self = this;
   if (!(self instanceof OfflineSync.Collection))
      throw new Error('use "new" to construct an OfflineSync.Collection');

   var activeSubscriptions = [];
   var collection = new Meteor.Collection(name, options);

   collection._ensureIndex({_writeTimeStamp: 1});
   collection._ensureIndex({_knownSince: 1});
   collection._ensureIndex({timeStamp: 1});

   collections[name] = collection;

   /*for every collection, a sync collection is created to record the log of actions*/
   var syncCollection = new Meteor.Collection("_deleted-" + name);

   this.collection = collection;
   this.deleted = syncCollection;

   /**make the offline collection available outside of the constructor*/
   offlineCollections[name] = this;

   /*every action is logged in order to be able to recreate it.
    * the actual data is not stored again and as the client has to fetch it explicitly, security rules can be enforced*/
   collection.find({
                      $and: [options.filter || {},
                         {$or: [
                            {_writeTimeStamp: {$gte: now}},
                            {_writeTimeStamp: {$exists: false}}
                         ]}]
                   },
                   {fields: {_writeTimeStamp: true}}).observe(
      {
         _suppress_initial: true,
         added: function (document) {
            var now = moment().unix();
            log.trace("document added to " + name);
            collection.update({_id: document._id}, {$set: {_writeTimeStamp: now}});
            document.__writeTimeStamp = now;
            document._knownSince = now;
            _(activeSubscriptions).each(function (sub) {
               sub.added(name + "_OfflineClient", document._id, document);
            })
         },
         changed: function (newDoc, oldDoc) {
            /*if the _writeTimeStamp fields are the same in both documents, the update has not been made in this function
             * nor is it an insert from the observer*/
            if (newDoc._writeTimeStamp == oldDoc._writeTimeStamp) {
               var now = moment().unix();
               collection.update({_id: newDoc._id}, {$set: {_writeTimeStamp: now}})
               newDoc._writeTimeStamp = now;
               _(activeSubscriptions).each(function (sub) {
                  sub.changed(name + "_OfflineClient", newDoc._id, newDoc);
               })
            }
         },
         removed: function (document) {
            _(activeSubscriptions).each(function (sub) {
               /*set the origin on removal in order to distinguish between removal because the subscription was stopped
                * and a real removal*/
               document.origin = "OfflineSync";
               document.timeStamp = moment().unix();
               sub.removed(name + "_OfflineClient", document._id);
            })
            /*we need to keep a reference of removals for those clients which are offline*/
            syncCollection.insert(
               {
                  docId: document._id,
                  timeStamp: moment().unix(),
                  collection: name
               }
            );
         }
      }
   );

   /*each client will subscribe to the changes since the last time it started and will get all the documents which were
    removed since the last time it was connected*/
   Meteor.publish(name + "Deleted", function (since) {
      /*if no start timestamp is given then subscribe to all events*/
      return syncCollection.find({timeStamp: {$gte: since || 1}});
   });

   /*this subscription is only used to send updates to the client*/
   Meteor.publish(name + "_OfflineSync", function (lastUpdate, lastRemoved) {
      'use strict';
      var sub = this;
      var subId = Random.id();

      activeSubscriptions.push(sub);
      /*when the subscription is stopped, remove it from the array of actives*/
      sub.onStop(function () {
         activeSubscriptions = _.without(activeSubscriptions, sub);
      });

      activeStreams[subId] = {
         name: name,
         filter: options.filter,
         sub: sub,
         lastUpdate: lastUpdate,
         lastRemoved: lastRemoved,
         data: 0
      };
      sub.added("OfflineCollectionsCount", name, {
         subscribed: -1,
         sent: -1,
         subscriptionId: subId
      });

   });
}

/**
 * every request for chunks is stored in the form of the cursor
 * */
var clients = [];

Meteor.startup(function () {
   Router.map(function () {
      this.route('json-data', {
         where: 'server',
         path: '/offlineSyncData/new/:stream/:chunk',
         action: function () {
            var response = this.response;
            try{
               var chunk = this.params.chunk || 0;
               var documents = [];
               var stream = activeStreams[this.params.stream];

               if(!stream) {
                  throw new Error("invalid stream " + this.params.stream);
               }

               var collection = collections[stream.name];

               var query = {};
               if (stream.lastUpdate) {
                  if (stream.filter)
                     query = {$and: [
                        {_writeTimeStamp: {$gt: stream.lastUpdate}},
                        stream.filter
                     ]};
                  else
                     query = {_writeTimeStamp: {$gt: stream.lastUpdate}};
               } else if (stream.filter) {
                  query = stream.filter;
               }

               if(!stream.docCount)
                  stream.docCount = collection.find(query).count();

               collection.find(query, {skip: chunk * chunkSize,
                  limit: chunkSize,
                  sort: {_knownSince: 1}}).forEach(function (document) {
                  documents.push(document);
               });

               var data = {
                  info: "chunkSize = number of documents in chunk, the chunk is 0 based, the chunkCount is always the same, " +
                     "the actual data is in the 'documents' attribute",
                  chunk: chunk,
                  chunkSize: documents.length,
                  docCount: stream.docCount,
                  documents: documents,
                  ready: stream.docCount <= chunk * chunkSize + documents.length
               };

               response.writeHead(200, {'Content-Type': 'application/json'});
               var strData = EJSON.stringify(data);
               stream.data = strData.length;
               var dataString;
               if(stream.data < 1024) {
                  dataString = stream.data + " bytes";
               } else if( stream.data < Math.pow(1024, 2)){
                  dataString = Math.floor(stream.data / 1024 * 100) / 100 + " KB";
               } else {
                  dataString = Math.floor(stream.data / Math.pow(1024, 2) * 100) / 100 + " MB";
               }
               /** once the stream has started, only the counts are relevant*/
               stream.sub.changed("OfflineCollectionsCount", stream.name, {
                  subscribed: stream.docCount,
                  sent: chunk * chunkSize + documents.length,
                  data: dataString
               });

               return response.end(strData);
            } catch (err) {
               response.writeHead(404, {'Content-Type': 'text/plain'}, err.message);
               return response.end();
            }
         }
      });
   });

   Router.map(function () {
      this.route('json-data', {
         where: 'server',
         path: '/offlineSyncData/removed/:stream/:chunk',
         action: function () {
            var response = this.response;
            try{
               var chunk = this.params.chunk || 0;
               var documents = [];
               var stream = activeStreams[this.params.stream];

               if(!stream) {
                  throw new Error("invalid stream " + this.params.stream);
               }

               var collection = offlineCollections[stream.name].deleted;

               collection.find({timeStamp: {$gt: stream.lastRemoved || 0}},
                               {
                                  skip: chunk * chunkSize,
                                  limit: chunkSize,
                                  sort: {timeStamp: 1}
                               })
                  .forEach(function (document) {
                              documents.push(document);
                           });

               var data = {
                  info: "chunkSize = number of documents in chunk, the chunk is 0 based, the chunkCount is always the same, " +
                     "the actual data is in the 'documents' attribute",
                  chunk: chunk,
                  chunkSize: documents.length,
                  docCount: stream.docCount,
                  documents: documents,
                  ready: stream.docCount <= chunk * chunkSize + documents.length
               };

               /*once all documents have been sent (0 is a valid count)*/
               if(stream.docCount <= chunk * chunkSize + documents.length) {
                  /*once the last chunk has been sent, the subscription is ready*/
                  stream.sub.ready();
                  log.trace("removing stream " + this.params.stream + " for " + stream.name + " from activeStreams");
                  delete(activeStreams[this.params.stream]);
               }

               response.writeHead(200, {'Content-Type': 'application/json'});
               return response.end(EJSON.stringify(data));
            } catch (err) {
               response.writeHead(404, {'Content-Type': 'text/plain'}, err.message);
               return response.end();
            }
         }
      });
   })
});
