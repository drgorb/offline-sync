activityTags = new OfflineSync.Collection("activityTags",
                                          {
                                             indexes: {name: "tag-hierarchy", attributes: ["catalog", "rootNode", "parent"]},
                                             filter: {validUntil: 2147483647},
                                             version: 1
                                          }
);

activities = new OfflineSync.Collection("activities",
                                        {
                                           indexes: {name: "tags", attributes: ["catalog", "tags"]},
                                           filter: {report: {$exists: false}, validUntil: 2147483647},
                                           version: 1
                                        }
);

tbabeCatalog = new OfflineSync.Collection("tbabeCatalog",
                                          {
                                             indexes: [
                                                {name: "type", attributes: "type"},
                                                {name: "strabsch", attributes: ["type", "kreis"]},
                                                {name: "objekt", attributes: ["type", "kreis", "strabsch", "marktyp"]}
                                             ],
                                             filter: undefined,
                                             version: 2
                                          }
);

/*
tbabeActivities = new OfflineSync.Collection("tbabeActivities",
                                        {
                                           indexes: {name: "tbabeTags", attributes: ["obj", "marktyp", "arbart"]},
                                           filter: {$or: [{old: false, old: {$exists: false}}]},
                                           version: 1
                                        }
);
*/
