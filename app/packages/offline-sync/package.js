Package.describe({
                    summary: "Synchronize Meteor.Collections offline. " +
                       "Once the data is on the client it will not be downloaded again"
                 });

Package.on_use(function (api) {
   "use strict";
   api.export && api.export('OfflineSync');
   api.export && api.export('_offlineSync', ['client', 'server'], {testOnly: true});

   api.use(['meteor',
              'underscore',
              'random',
              'moment',
              'minimongo',
              'ejson',
              'http',
              'deps',
              'pince',
              'crypto-md5',
              'standard-app-packages'],
           ['client', 'server']);

   api.use(['iron-router'], 'server');

   api.add_files(['offlineSync.client.js'], 'client');
   api.add_files('offlineSync.server.js', 'server');

});