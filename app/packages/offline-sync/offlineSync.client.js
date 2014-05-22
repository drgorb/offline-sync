var log = new Logger("offlineSync:client");
Logger.setLevel({log: "trace"});
var collections = {};
var client = {};
var subscriptions = {};

var publish = {};

/*call the queued subscriptions*/
var subcribeAll = function(db){
   OfflineSync.db = db;
   log.trace("subscribing to " + EJSON.stringify(OfflineSync.db.objectStoreNames));
   /*get al the documents since last update for each collection
    * each storeName is the same as the offline collection's*/
   /*we want to call the subscriptions one after the other. for this we put the calls in an array and
   * use async.series to execute them*/
   var subscriptionCalls = [];
   _(OfflineSync.db.objectStoreNames).each(function(storeName){
      /*only do the subscription thing for collections which have been initialized. the IndexedDB might be used
      for other things as well*/
      if(collections[storeName]){
         subscriptionCalls.push(function (callback) {
            log.trace("subscription for " + storeName);
            var tx = db.transaction(storeName);
            var store = tx.objectStore(storeName);
            store.get("_lastUpdate").onsuccess = function (evt) {
               var lastUpdate = undefined;
               if (evt.target.result)
                  lastUpdate = evt.target.result.lastUpdate;
               store.get("_lastRemoved").onsuccess = function (evt) {
                  var lastRemoved = undefined;
                  if (evt.target.result)
                     lastRemoved = evt.target.result.lastRemoved;

                  /*subscribe to the offlineSync and call the callback when the subscription is ready*/
                  log.trace("subscribing to " + storeName + "with lastUpdate " + lastUpdate + " and lastRemoved " + lastRemoved);
                  Meteor.subscribe(storeName + "_OfflineSync", lastUpdate, lastRemoved,
                     /*this function is called once all the documents have been pulled and stored in indexeddb*/
                                   function (err) {
                                      if (err) log.error(err);
                                      log.trace(storeName + " is ready");
                                      var tx = OfflineSync.db.transaction(storeName);
                                      var store = tx.objectStore(storeName);
                                      /*store the number of documents from the indexeddb*/
                                      store.count().onsuccess = function (evt) {
                                         /*remove 2 from the count because the _lastUpdate and _lastRemoved should not be counted*/
                                         collections[storeName]._setStored(evt.target.result - 2);
                                      }
                                      collections[storeName]._setReady(true);
                                      /*continue with the other subscriptions*/
                                      callback();
                                   });
                  OfflineSync.OfflineCollectionsCount.find({_id: storeName}).observe(
                     {
                        /** this is called when the count document for the collection is first created
                         * this happens in the publish method and signals the availability of the chunks*/
                        added: function (newDoc) {
                           var errorCount = 0;
                           var getJSON = function (chunk, method) {
                              HTTP.get(Meteor.absoluteUrl() + "offlineSyncData/"+method+"/" + newDoc.subscriptionId +
                                          "/" + chunk, {timeout: 60000}, function (err, result) {
                                 /**check that everything went fine before storing the data*/
                                 if (!err && result.data && _(result.data.documents).isArray()) {
                                    /*fill the objectStore with the returned rows*/
                                    var tx = OfflineSync.db.transaction(storeName, "readwrite");
                                    var store = tx.objectStore(storeName);
                                    var i = 0;
                                    _(result.data.documents).each(function (document) {
                                       if(method == "new"){
                                          store.put(document).onsuccess = function(evt){
                                             log.trace("written row " + (++i) + " to " + storeName);
                                          };
                                          if (lastUpdate < document._writeTimeStamp) {
                                             lastUpdate = document._writeTimeStamp;
                                          }
                                       } else if(method == "removed"){
                                          store.delete(document._id);
                                          if (lastRemoved < document.timeStamp) {
                                             lastRemoved = document.timeStamp;
                                          }
                                       }
                                    });
                                 } else {
                                    errorCount = errorCount + 1;
                                    /*reduce the chunk number in order to try again*/
                                    chunk--;
                                    if (err) {
                                       log.error(err);
                                    } else {
                                       log.error("no result but no error either for " + storeName);
                                    }
                                 }
                                 /**
                                  * once the documents have been written to the database the next call must be made
                                  * once all chunks have been received (ready == true),
                                  * the subscription is ready and its callback is called
                                  */
                                 if (errorCount < 10 && (!result.data || (result.data && !result.data.ready))) {
                                    /*get the next chunk*/
                                    getJSON(chunk + 1, method);//as this call is made from inside a callback it does not count as recursive
                                 } else if (result.data && result.data.ready){
                                    tx = OfflineSync.db.transaction(storeName, "readwrite");
                                    store = tx.objectStore(storeName);
                                    if(method == "new") {
                                       /*lastUpdate might be undefined if none of the documents contained the attribute or no
                                        * documents were retrieved*/
                                       if (!lastUpdate) {
                                          lastUpdate = 1;
                                       }
                                       //initialize the timestamp in order to avoid getting all the rows next time
                                       store.put({
                                                    _id: "_lastUpdate",
                                                    lastUpdate: lastUpdate
                                                 });
                                       /*once all the new documents have been downloaded, remove the ones which have been
                                        * deleted since last update*/
                                       getJSON(0, "removed");
                                    } else if(method == "removed"){
                                       /*lastRemoved might be undefined if nothing was removed since last sync*/
                                       if (!lastRemoved) {
                                          lastRemoved = 1;
                                       }
                                       //initialize the timestamp in order to avoid getting all the rows next time
                                       store.put({
                                                    _id: "_lastRemoved",
                                                    lastRemoved: lastRemoved
                                                 });

                                    }
                                 }
                              });
                           }
                           /*this is the starting point of the data seeding process - call the first chunk*/
                           getJSON(0, "new");
                        }
                     })
               }
            }
         });
      }
   });

   if(subscriptionCalls.length > 0){
      log.trace("calling "+subscriptionCalls.length+"subscriptions");
      async.series(subscriptionCalls);
   }
}

OfflineSync = {
   minUpdateDelay: 120000 /*do not update more often than every two minutes*/,
   DB_NAME: "SyncedOfflineData",
   db: undefined,
   OfflineCollectionsCount: new Meteor.Collection("OfflineCollectionsCount"),
   createDb: function () {
      /*start by getting version 1 of the DB. If it does not exist, no clientID has been created*/
      var request = indexedDB.open(OfflineSync.DB_NAME);
      /*this is the creation of the version 1 of the database which does not contain any data*/
      request.onupgradeneeded = function (event) {
         /*just create the object store for the offline id. The last version of the database and the client id will be
          * stored here*/
         event.currentTarget.result.createObjectStore("OFFLINE_ID", { keyPath: 'id' });
      }

      /*the database could be created and initialized*/
      request.onsuccess = function (evt) {
         'use strict';
         // Better use "this" than "req" to get the result to avoid problems with garbage collection. db = req.result;
         var db = this.result;
         log.info("openDb DONE");
         var tx = db.transaction("OFFLINE_ID", "readwrite");
         var store = tx.objectStore("OFFLINE_ID");

         store.onerror = function (event) {
            log.error(event, "error on store");
         }

         store.openCursor().onsuccess = function (event) {
            /*we are interested in the first entry of the data store. there shall be no other*/
            var cursor = event.target.result;
            if (cursor) {
               client = cursor.value;
               log.debug(client);
               OfflineSync.createObjectStores(db);
            } else {
               log.info("no values in OFFLINE_ID, store empty defaults");
               client.id = Random.id();

               try {
                  store.put(client);

                  tx.onerror = function (event) {
                     log.error(event, "error on store");
                  }

                  tx.oncomplete = function (evt) {
                     log.info("new Offline document stored");
                     OfflineSync.createObjectStores(db);
                  }

               } catch (error) {
                  log.error(error);
               }
            }
            client.sessionId = Random.id();
         }
      }

      request.onerror = function(err) {
         log.error(err);
      }
   },
   createObjectStores: function (db) {
      'use strict';
      /*first find out which collections are not in the database*/
      var collectionDefs = [];
      _(collections).each(function(collection){
         collectionDefs.push(collection.collectionDef);
      })
      var newList = _.difference(_(_.toArray(collectionDefs)).pluck("hash"), _(_.toArray(client.collections)).pluck("hash"));
      /*if any new collection has been added then create the data store*/
      if (newList.length > 0) {
         log.trace("closing database");
         db.close();
         /*replace the list of collections with the new ones*/
         client.collections = collectionDefs;
         /*we will need to close the db before creating the new version and must remember it before closing*/
         var newVersion = db.version + 1;
         /*wait for the database to close and then create a new version of it
          * we use a setTimeout because the close event of the database does not fire*/
         Meteor.setTimeout(function () {
            log.trace("database closed");
            var request = indexedDB.open(OfflineSync.DB_NAME, newVersion);

            /*we know this function will be called as the newVersion is higher then the existing one*/
            request.onupgradeneeded = function (event) {
               db = this.result;

               /*create an object store for each collection*/
               _(newList).each(function (hash) {
                  var collection = _(collectionDefs).find(function (col) {
                     return col.hash == hash;
                  });
                  var objectStore;
                  /*for each collection there is an object store*/
                  /*first try to delete the store if they exist in order to avoid conflicts*/
                  if (db.objectStoreNames.contains(collection.name)) {
                     try {
                        db.deleteObjectStore(collection.name);
                     } catch (err) {
                        log.error(err);
                     }
                  }
                  /*once the object store does not exist anymore, create it*/
                  objectStore = db.createObjectStore(collection.name, { keyPath: '_id' });
                  /*and create the indices*/
                  if (collection.indexes) {
                     if (_.isArray(collection.indexes)) {
                        _(collection.indexes).each(function (index) {
                           objectStore.createIndex(index.name, index.attributes,
                                                   { unique: index.unique === true});
                        });
                     } else {
                        objectStore.createIndex(collection.indexes.name, collection.indexes.attributes,
                                                { unique: collection.indexes.unique === true });
                     }
                  }
               });
            };

            /*once the database has been update (or not) the onsuccess event is fired*/
            request.onsuccess = function (evt) {
               var tx = db.transaction("OFFLINE_ID", "readwrite");
               var store = tx.objectStore("OFFLINE_ID");
               store.put(client);
               subcribeAll(db);
            }

            request.onerror = function (event) {
               log.error(event);
               throw new Meteor.Error(event);
            }
         }, 500);

      } else {
         /*no changes made to the model, lets get the data from the server*/
         subcribeAll(db);
      }
   },

   /**
    * register a subscription. the callback must return an object with the following structure:
    * collection with the name of the collection
    * an array of documents which will be inserted in the offline collection
    * if the returned value is an array, it is expected to contain objects with this structure
    * collection when the subscribe function is called with the same name
    * @param name the name which can be subscribed to
    * @param pubFunction the function to get the documents
    */
   publish: function (name, pubFunction) {
      if (!_.isFunction(pubFunction)) {
         throw new Meteor.Error("the subscription must be a function");
      }

      publish[name] = {
         pubFunction: pubFunction,
         state: {
            readyDep: new Deps.Dependency(),
            isReady: false,
            _setReady: function(value){
               if(value != this.isReady){
                  this.isReady = value;
                  this.readyDep.changed();
               }
            },
            /**
             * a reactive value to find out whether the subscription has finished
             * @returns {boolean}
             */
            ready: function(){
               this.readyDep.depend();
               return this.isReady;
            },
            /**
             * we only reset the ready value to false. the documents stay in the local collection
             */
            stop: function(){
               this._setReady(false);
            }
         }
      };

      return publish[name].state;
   },

   subscribe: function (name) {
      if (publish[name] && _.isFunction(publish[name].pubFunction)) {
         var insertDocs = function (collection, documents) {
            _(documents).each(function (document) {
               collection.insert(document);
            });
         }
         /** get the docments by calling the pubFunction from the publish definition
          * the result is either a single object or an array of objects. The objects must have two attributes:
          * collection: the client side offline collection to which the documents should be added
          * documents: an array of documents to be added to the collection*/
         var args = Array.prototype.slice.call(arguments, 1);
         var callback = undefined;
         if(_.isFunction(_(args).last())){
            callback = _(args).last();
            args.pop();
         }

         /** because of the asynchronous nature of indexeddb, the result is provided in a callback*/
         args.push(function(sub){
            if (_.isArray(sub)) {
               _.each(sub, function (res) {
                  insertDocs(res.collection, res.documents);
               });
            } else {
               insertDocs(sub.collection, sub.documents);
            }
            publish[name].state._setReady(true);
            if(callback) callback();
         });

         publish[name].pubFunction.apply(undefined, args);

      }
   }

};

Meteor.startup(function () {
   /*all the new Meteor.Collection statements must have been made outside of Meteor.startup in order to occur before
    the creation of the data stores*/
   OfflineSync.createDb();
})

OfflineSync.Collection = function (name, options) {
   var self = this;
   /*set a lastupdate timestamp to nothing in order to get all documents on first subscription*/
   self.lastUpdate = undefined;

   if (!(self instanceof OfflineSync.Collection))
      throw new Error('use "new" to construct an OfflineSync.Collection');
   this.name = name;
   /*we create a client only collection that will hold the localy synchronized documents*/
   var syncCollection = new Meteor.Collection(name + "_OfflineClient", options);
   var collection = new Meteor.Collection(null);

   /*this will be used in Meteor.startup to create the data stores in the indexed db*/
   this.collectionDef = {
      name: name,
      indexes: options ? options.indexes : undefined,
      version: options ? options.version : undefined
   };
   this.collectionDef.hash = CryptoJS.MD5(EJSON.stringify(this.collectionDef)).toString()
   collections[name] = this;

   /*the observer will trigger the necessary actions for storing the documents in the indexedDB*/
   syncCollection.find({}).observe(
      {
         added: function (newDoc) {
            collection.insert(newDoc);
            var tx = OfflineSync.db.transaction(self.name, "readwrite");
            var store = tx.objectStore(self.name);
            store.put(newDoc);
            if (!self.lastUpdate || self.lastUpdate < newDoc._writeTimeStamp) {
               self.lastUpdate = newDoc._writeTimeStamp;
               store.put({
                            _id: "_lastUpdate",
                            lastUpdate: newDoc._writeTimeStamp
                         })
            }
         },
         changed: function (newDoc) {
            collection.update({_id: newDoc._id}, {$set: _(newDoc).omit("_id")})

            var tx = OfflineSync.db.transaction(self.name, "readwrite");
            var store = tx.objectStore(self.name);
            store.put(newDoc);
            if (!self.lastUpdate || self.lastUpdate < newDoc._writeTimeStamp) {
               self.lastUpdate = newDoc._writeTimeStamp;
               store.put({
                            _id: "_lastUpdate",
                            lastUpdate: newDoc._writeTimeStamp
                         })
            }
         },
         removed: function (removedDoc) {
            collection.remove({_id: newDoc._id})

            var tx = OfflineSync.db.transaction(self.name, "readwrite");
            var store = tx.objectStore(self.name);
            store.delete(removedDoc.docId);
            if (!self.lastDelete || self.lastDelete < removedDoc.timeStamp) {
               self.lastDelete = removedDoc.timeStamp;
               store.put({
                            _id: "_lastRemoved",
                            lastRemoved: removedDoc.timeStamp
                         })
            }
         }
      }
   );

   var readyDep = new Deps.Dependency;
   var isReady = false;
   this._setReady = function(value){
      if(value != isReady){
         isReady = value;
         readyDep.changed();
      }
   }

   this.ready = function(){
      readyDep.depend();
      return isReady;
   }

   var storedDep = new Deps.Dependency;
   var storedCount = false;
   this._setStored = function(value){
      if(value != storedCount){
         storedCount = value;
         storedDep.changed();
      }
   }

   this.stored = function(){
      storedDep.depend();
      return storedCount;
   }

   this.counts = function(){
      var counts = OfflineSync.OfflineCollectionsCount.findOne({_id: self.name});
      if(counts)
         counts.stored = this.stored();

      return counts;
   }

   this.findOne = function(query){
      return collection.findOne(query || {});
   }

   this.find = function(query){
      return collection.find(query || {});
   }

   this.insert = function (document) {
      collection.insert(document);
   }

   this.update = function (query, value, options) {
      collection.update(query, value, options);
   }

   this.remove = function (query) {
      collection.remove(query);
   }

}