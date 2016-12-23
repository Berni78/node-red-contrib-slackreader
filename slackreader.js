/*jshint esversion: 6 */
module.exports = function(RED) {

    // Load required modules
    const PubSub            = require('pubsub-js');

    const SlackClient       = require('@slack/client').RtmClient;
    const MemoryDataStore   = require('@slack/client').MemoryDataStore;
    const SlackSearch       = require('@slack/client').SearchFacet;

    const CLIENT_EVENTS     = require('@slack/client').CLIENT_EVENTS;
    const RTM_EVENTS        = require('@slack/client').RTM_EVENTS;
    const CLIENT_RTM_EVENTS = require('@slack/client').CLIENT_EVENTS.RTM;

    /**
     * Slackreader module
     */
    var Slackreader = (function(){

        // Expose properties & methods
        var public = {};

        return public;
    })();

    /**
     * Manages SlackClients
     */
    Slackreader.Clients = (function(){
        var _list = [];

        /**
         * Creates a new client
         */
        var _create = function(token) {

            var client = new SlackClient(token, {
                logLevel: 'none',
                dataStore: new MemoryDataStore(),
            });
            //var search = new SlackSearch();

            // Client connecting
            client.on(CLIENT_EVENTS.RTM.CONNECTING, function() {
                PubSub.publish('slackreader.client.connecting');
            });

            // Client start success
            client.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function (data) {
                PubSub.publish('slackreader.client.authenticated', data);
            });

            // Client start failure (may be recoverable)
            client.on(CLIENT_EVENTS.RTM.UNABLE_TO_RTM_START, function(error) {
                PubSub.publish('slackreader.client.unableToStart', error);
            });

            // Client disconnect
            client.on(CLIENT_EVENTS.RTM.DISCONNECT, function(optError, optCode) {
                PubSub.publish('slackreader.client.disconnect', {
                    optError: optError,
                    optCode: optCode,
                });
            });

            // Client connection opened
            client.on(CLIENT_EVENTS.RTM.RTM_CONNECTION_OPENED, function() {
                PubSub.publish('slackreader.client.connectionOpened');
                PubSub.publish('slackreader.client.history');

                // Read History message
            });

            // Team received a message
            client.on(RTM_EVENTS.MESSAGE, function (message) {
                PubSub.publish('slackreader.client.message', message);
            });


            client.start();

            return client;
        };

        /**
         * Retrieves a client by API token
         */
        var getByToken = function(token) {
            if(token == null || token.trim() == '') {
                console.log('Slackreader ~ no token specified');
                return false;
            }

            // Create a new client if it doesn't already exist
            if(_list[token] == null) {
                _list[token] = _create(token);
            }

            return _list[token];
        };

        /**
         * Deletes a client by API token
         */
        var deleteByToken = function(token) {
            // Disconnet & remove from the client list
            if(_list[token] != null) {
                _list[token].disconnect();
                _list[token] = null;
            }
        };

        var search = function(query) {
          history = Slackreader.Clients.search.messages(query);
          return history;
        };
        // Expose properties & methods
        var public = {};

        public.getByToken = getByToken;
        public.deleteByToken = deleteByToken;
        public.search = search;

        return public;
    })();

    /**
     * Logger
     */
    Slackreader.Logger = (function() {
        var connecting = function(msg) {
            console.log(`Slackreader ~ connecting...`);
        };

        var authenticated = function(msg, data) {
            console.log(`Slackreader ~ logged in as @${data.self.name} of team ${data.team.name}`);
        };

        var unableToStart = function(msg, data) {
            console.log(`Slackreader ~ unable to connect`);
        };

        var disconnect = function(msg) {
            //console.log(data.optError, data.optCode);
            console.log(`Slackreader ~ disconnected`);
        };

        var message = function(msg, data) {
            console.log(`Slackreader ~ received a message`);
        };

        var history = function() {
            console.log(`Slackreader ~ Search received a message`);
        };

        PubSub.subscribe('slackreader.client.disconnect', disconnect);
        PubSub.subscribe('slackreader.client.unableToStart', unableToStart);
        PubSub.subscribe('slackreader.client.connecting', connecting);
        PubSub.subscribe('slackreader.client.message', message);
        PubSub.subscribe('slackreader.client.history', history);
        PubSub.subscribe('slackreader.client.authenticated', authenticated);
    })();

    /**
     * Speaker
     */
    Slackreader.Speaker = (function(config) {
        RED.nodes.createNode(this, config);

        const client = Slackreader.Clients.getByToken(config.apiToken);
        const node = this;

        var disconnect = function() {
            node.status({
                fill: "red",
                shape: "dot",
                text: "disconnected",
            });
        };

        var connectionOpened = function() {
            node.status({
                fill: "green",
                shape: "dot",
                text: "connected",
            });
        };

        var subscriptions = [
            PubSub.subscribe('slackreader.client.disconnect', disconnect),
            PubSub.subscribe('slackreader.client.connectionOpened', connectionOpened),
        ];

        node.on('input', function(msg) {
            if(msg.payload == null || msg.payload.trim() == '') {
                msg.payload = 'Nothing was specified, please pass a payload property to the msg object';
            }
            client.sendMessage(msg.payload, msg.channel.id);
        });

        node.on('close', function() {
            Slackreader.Clients.deleteByToken(config.apiToken);
            for(var s in subscriptions) {
               PubSub.unsubscribe(subscriptions[s]);
           }
        });

        PubSub.subscribe('slackreader.client.disconnect', disconnect);

        return node;
    });

    /**
     * Auditor
     */
    Slackreader.Auditor = (function(config) {
        RED.nodes.createNode(this, config);

        var client = Slackreader.Clients.getByToken(config.apiToken);
        var node = this;

        var channelIsWatched = function(channelId, watchList) {
            if(watchList != null && watchList.trim() != '') { // Listen only on specified channels
                if(channelId.substr(0,1) == 'D') {
                    return true;
                }
                var watchedChannels = config.channels.split(',');
                for(var i = 0, m = watchedChannels.length; i < m; i++) {
                    var channel = client.dataStore.getChannelOrGroupByName(watchedChannels[i]);
                    if(channelId == channel.id) {
                        return true;
                    }
                }
            } else { // Listen on all channels
                return true;
            }
            return false;
        };

        var disconnect = function() {
            node.status({
                fill: "red",
                shape: "dot",
                text: "disconnected",
            });
        };

        var authenticated = function() {

            node.status({
                fill: "green",
                shape: "dot",
                text: "connected",
            });
        };

        var message = function(msg, data) {

            // Ignore deleted messages
            if(data.subtype != null && data.subtype == 'message_deleted') {
                return false;
            }


            if(channelIsWatched(data.channel, config.channels)) {
                if(data.attachments) attach=JSON.stringify(data.attachments);
                var output = {
                    payload: data.text,
                    channel: {
                        id: data.channel,
                    },
                    rawmsg : {
                      message: data,
                    },
                    slackObj: {
                        ts: data.ts,
                        user: data.user,
                        attachments: JSON.parse(attach),
                        commit: "NO"
                    }
                };

                node.send(output);
            }
        };

        var subscriptions = [
            PubSub.subscribe('slackreader.client.message', message),
            PubSub.subscribe('slackreader.client.disconnect', disconnect),
            PubSub.subscribe('slackreader.client.authenticated', authenticated),
        ];

        node.on('close', function() {
           Slackreader.Clients.deleteByToken(config.apiToken);
           for(var s in subscriptions) {
               PubSub.unsubscribe(subscriptions[s]);
           }
        });

        return node;
    });

    /**
     * History search
     */
    Slackreader.History = (function(config) {
        RED.nodes.createNode(this, config);

        var client = Slackreader.Clients.getByToken(config.apiToken);
        var node = this;

        var channelIsWatched = function(channelId, watchList) {
            if(watchList != null && watchList.trim() != '') { // Listen only on specified channels
                if(channelId.substr(0,1) == 'D') {
                    return true;
                }
                var watchedChannels = config.channels.split(',');
                for(var i = 0, m = watchedChannels.length; i < m; i++) {
                    var channel = client.dataStore.getChannelOrGroupByName(watchedChannels[i]);
                    if(channelId == channel.id) {
                        return true;
                    }
                }
            } else { // Listen on all channels
                return true;
            }
            return false;
        };

        var disconnect = function() {
            node.status({
                fill: "red",
                shape: "dot",
                text: "disconnected",
            });
        };

        var authenticated = function() {

            node.status({
                fill: "green",
                shape: "dot",
                text: "connected",
            });
        };

        var history = function() {

          msg = Slackreader.Clients.search('camembert');
          console.log('SlackSearch '+msg);

            // Ignore deleted messages
            if(data.subtype != null && data.subtype == 'message_deleted') {
                return false;
            }


            if(channelIsWatched(data.channel, config.channels)) {
                if(data.attachments) attach=JSON.stringify(data.attachments);
                var output = {
                    payload: data.text,
                    channel: {
                        id: data.channel,
                    },
                    rawmsg : {
                      message: data,
                    },
                    slackObj: {
                        ts: data.ts,
                        user: data.user,
                        attachments: JSON.parse(attach),
                        commit: "NO"
                    }
                };

                node.send(msg);
            }
        };

        var subscriptions = [
            PubSub.subscribe('slackreader.client.history', history),
            PubSub.subscribe('slackreader.client.disconnect', disconnect),
            PubSub.subscribe('slackreader.client.authenticated', authenticated),
        ];

        node.on('close', function() {
           Slackreader.Clients.deleteByToken(config.apiToken);
           for(var s in subscriptions) {
               PubSub.unsubscribe(subscriptions[s]);
           }
        });

        return node;
    });

    RED.nodes.registerType("slackreader-auditor", Slackreader.Auditor);
    RED.nodes.registerType("slackreader-speaker", Slackreader.Speaker);
    RED.nodes.registerType("slackreader-history", Slackreader.History);

};
