log = new Logger("client");
Logger.setLevel({log: "trace"});

Meteor.startup(function () {
   OfflineSync.publish("kreis", function (callback) {
      var tx = OfflineSync.db.transaction("tbabeCatalog");
      var store = tx.objectStore("tbabeCatalog");
      var index = store.index("type");
      var res = [];

      index.openCursor(IDBKeyRange.only("kreis")).onsuccess = function (event) {
         if (event.target.result) {
            try {
               res.push(event.target.result.value);
            } catch (error) {
               log.error(error);
            } finally {
               event.target.result.continue();
            }
         } else {/*once there is no more data, let the publish know*/
            callback({
                        collection: tbabeCatalog,
                        documents: res
                     });
         }
      };
   })

   OfflineSync.publish("strabsch", function (kreis, callback) {
      var tx = OfflineSync.db.transaction("tbabeCatalog");
      var store = tx.objectStore("tbabeCatalog");
      var index = store.index("strabsch");
      var res = [];

      index.openCursor(IDBKeyRange.only(["strabsch", kreis._id])).onsuccess = function (event) {
         if (event.target.result) {
            try {
               res.push(event.target.result.value);
            } catch (error) {
               log.error(error);
            } finally {
               event.target.result.continue();
            }
         } else {/*once there is no more data, let the publish know*/
            callback({
                        collection: tbabeCatalog,
                        documents: res
                     });
         }
      };
   })

   OfflineSync.subscribe("kreis", function () {
      console.log("tbabeCatalog count = " + tbabeCatalog.find().count());
      var kreis = tbabeCatalog.findOne({type: "kreis"});
      Session.set("selectedKreis", kreis);
      OfflineSync.subscribe("strabsch", kreis, function () {
         console.log("strabsch count for " + kreis.name.de + " = " + tbabeCatalog.find({type: "strabsch"}).count());
         Session.set("selectedStrabsch", tbabeCatalog.findOne({type: "strabsch", kreis: kreis._id}))
      });

   });
});

