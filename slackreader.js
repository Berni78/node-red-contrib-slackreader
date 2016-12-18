module.exports = function(RED) {

    // Load required modules
    const PubSub            = require('pubsub-js');

    const SlackClient       = require('@slack/client').RtmClient;
    const MemoryDataStore   = require('@slack/client').MemoryDataStore;

    const CLIENT_EVENTS     = require('@slack/client').CLIENT_EVENTS;
    const RTM_EVENTS        = require('@slack/client').RTM_EVENTS;
    const CLIENT_RTM_EVENTS = require('@slack/client').CLIENT_EVENTS.RTM;

    /**
     * Slackor module
     */
    var Slackor = (function(){

        // Expose properties & methods
        var public = {};

        return public;
    })();

    /**
     * Manages SlackClients
     */
    Slackor.Clients = (function(){
        var _list = [];

        /**
         * Creates a new client
         */
        var _create = function(token) {

            var client = new SlackClient(token, {
                logLevel: 'none',
                dataStore: new MemoryDataStore(),
            });

            // Client connecting
            client.on(CLIENT_EVENTS.RTM.CONNECTING, function() {
                PubSub.publish('slackor.client.connecting');
            });

            // Client start success
            client.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function (data) {
                PubSub.publish('slackor.client.authenticated', data);
            });

            // Client start failure (may be recoverable)
            client.on(CLIENT_EVENTS.RTM.UNABLE_TO_RTM_START, function(error) {
                PubSub.publish('slackor.client.unableToStart', error);
            });

            // Client disconnect
            client.on(CLIENT_EVENTS.RTM.DISCONNECT, function(optError, optCode) {
                PubSub.publish('slackor.client.disconnect', {
                    optError: optError,
                    optCode: optCode,
                });
            });

            // Client connection opened
            client.on(CLIENT_EVENTS.RTM.RTM_CONNECTION_OPENED, function() {
                PubSub.publish('slackor.client.connectionOpened');
            });

            // Team received a message
            client.on(RTM_EVENTS.MESSAGE, function (message) {
                PubSub.publish('slackor.client.message', message);
            });


            client.start();

            return client;
        };

        /**
         * Retrieves a client by API token
         */
        var getByToken = function(token) {
            if(token == null || token.trim() == '') {
                console.log('Slackor ~ no token specified');
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

        // Expose properties & methods
        var public = {};

        public.getByToken = getByToken;
        public.deleteByToken = deleteByToken;

        return public;
    })();

    /**
     * Logger
     */
    Slackor.Logger = (function() {
        var connecting = function(msg) {
            console.log(`Slackor ~ connecting...`);
        };

        var authenticated = function(msg, data) {
            console.log(`Slackor ~ logged in as @${data.self.name} of team ${data.team.name}`);
        };

        var unableToStart = function(msg, data) {
            console.log(`Slackor ~ unable to connect`);
        };

        var disconnect = function(msg) {
            //console.log(data.optError, data.optCode);
            console.log(`Slackor ~ disconnected`);
        };

        var message = function(msg, data) {
            console.log(`Slackor ~ received a message`);
        };

        PubSub.subscribe('slackor.client.disconnect', disconnect);
        PubSub.subscribe('slackor.client.unableToStart', unableToStart);
        PubSub.subscribe('slackor.client.connecting', connecting);
        PubSub.subscribe('slackor.client.message', message);
        PubSub.subscribe('slackor.client.authenticated', authenticated);
    })();

    /**
     * Speaker
     */
    Slackor.Speaker = (function(config) {
        RED.nodes.createNode(this, config);

        const client = Slackor.Clients.getByToken(config.apiToken);
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
            PubSub.subscribe('slackor.client.disconnect', disconnect),
            PubSub.subscribe('slackor.client.connectionOpened', connectionOpened),
        ];

        node.on('input', function(msg) {
            if(msg.payload == null || msg.payload.trim() == '') {
                msg.payload = 'Nothing was specified, please pass a payload property to the msg object';
            }
            client.sendMessage(msg.payload, msg.channel.id);
        });

        node.on('close', function() {
            Slackor.Clients.deleteByToken(config.apiToken);
            for(var s in subscriptions) {
               PubSub.unsubscribe(subscriptions[s]);
           }
        });

        PubSub.subscribe('slackor.client.disconnect', disconnect);

        return node;
    });

    /**
     * Speaker
     */
    Slackor.Auditor = (function(config) {
        RED.nodes.createNode(this, config);

        var client = Slackor.Clients.getByToken(config.apiToken);
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
                var output = {
                    channel: {
                        id: data.channel,
                    },
                };

                node.send(output);
            }
        };

        var subscriptions = [
            PubSub.subscribe('slackor.client.message', message),
            PubSub.subscribe('slackor.client.disconnect', disconnect),
            PubSub.subscribe('slackor.client.authenticated', authenticated),
        ];

        node.on('close', function() {
           Slackor.Clients.deleteByToken(config.apiToken);
           for(var s in subscriptions) {
               PubSub.unsubscribe(subscriptions[s]);
           }
        });

        return node;
    });

    RED.nodes.registerType("slackor-auditor", Slackor.Auditor);
    RED.nodes.registerType("slackor-speaker", Slackor.Speaker);
};