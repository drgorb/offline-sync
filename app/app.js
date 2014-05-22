if (Meteor.isClient) {

   Router.map(function() {
      this.route("tbabe", {
         path: "/tba",
         template: "tbabe",
         waitOn: function(){

         }
      })
      this.route("root", {
         path: "*",
         template: "hello"
      });
   })

   testCollection = new Meteor.Collection("testCollection");

   Template.hello.created = function () {
      this._stopHandle = Meteor.subscribe("test");
   }

   Template.hello.rendered = function() {
   }

   Template.hello.helpers(
      {
         activityTagsReady: function() {
            return activityTags.ready();
         },
         activityTags: function() {
            return activityTags.counts();
         },
         activities: function() {
            return activities.counts();
         },
         tbabeCatalog: function() {
            return tbabeCatalog.counts();
         },
         tbabeActivities: function() {
            return tbabeActivities.counts();
         },
         kreis: function(){
            return tbabeCatalog.find({type: "kreis"});
         },
         selectedKreis: function(){
            return Session.get("selectedKreis");
         },
         strabsch: function(){
            if(Session.get("selectedKreis"))
               return tbabeCatalog.find({type: "strabsch", kreis: Session.get("selectedKreis")._id});
         },
         selectedStrabsch: function(){
            return Session.get("selectedStrabsch");
         }

      });

   Template.hello.events(
      {
         'click .kreis': function(){
            Session.set("selectedKreis", this);
            OfflineSync.subscribe("strabsch", this, function () {
               console.log("strabsch count = " + tbabeCatalog.find({type: "strabsch"}).count());
            });

         },
         'click .strabsch': function(){
            Session.set("selectedStrabsch", this);
         },
         'click input': function () {
            log.info("calling delete database " + moment().format("ss:SS"));

            var request = indexedDB.deleteDatabase(OfflineSync.DB_NAME);

            request.onsuccess = function (event) {
               log.info("database deleted " + moment().format("ss:SS"));
               OfflineSync.createDb();
            }
            request.onerror = function (event) {
               log.error(event);
            }
         },
         'click h1': function (event) {
            var arr = [];
            var delay = 100;
            var getObjects = function () {
               for (var i = 0; i < 1000; i++) {
                  arr.push(
                     {
                        id: Random.id(),
                        name: "element-" + i,
                        message: "just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string just a lengthy string "
                     })
               }
               return arr;
            }

            Meteor.setInterval(function () {
               getObjects();
               Session.set("elements", arr.length);
            }, delay);
         }
      });
}

if (Meteor.isServer) {
   var subs = {};

   Meteor.setInterval(function () {
      _(subs).each(function (sub, userId) {
         sub.changed("testCollection", "server-time", {serverTime: moment().format("hh:mm:ss"), user: userId});
      })
   }, 1000);

   Meteor.publish("test", function () {
      if (this.userId) {
         subs[this.userId] = this;
         this.added("testCollection", "server-time", {serverTime: moment().format("hh:mm:ss"), user: this.userId});
         this.ready();
      }
   })
}
