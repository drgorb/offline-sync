log = new Logger("server");
Logger.setLevel({log: "trace"});

log.trace("outside in file");

Meteor.startup(function () {
   log.trace("inside in file");
});
