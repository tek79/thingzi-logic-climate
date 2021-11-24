module.exports = function(RED) {
    'use strict'
    const moment = require('moment');
    const mqtt = require('./mqtt');

    RED.nodes.registerType('thingzi-climate', function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // Internal State
        this.name = config.name || this.id;
        this.deviceId = config.name ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}-climate` : `${this.id}-climate`;
        this.sendStatus = config.sendStatus;
        this.outputs = config.outputs;
        this.updateTimeout = null;
        this.boostTimeout = null;
        this.starting = true;

        // Configuration
        this.keepAliveMs = parseFloat(config.keepAlive) * 1000 * 60; //< mins to ms
        this.cycleDelayMs = parseFloat(config.cycleDelay) * 1000; //< seconds to ms
        this.boostDurationMs = parseFloat(config.boostDuration) * 1000 * 60; //< mins to ms

        // Set Point
        this.degrees = config.degrees;
        this.defaultSetPoint = parseFloat(config.defaultSetPoint);
        this.tolerance = parseFloat(config.tolerance);
        this.minTemp = parseFloat(config.minTemp);
        this.maxTemp = parseFloat(config.maxTemp);
        this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
        this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms
        
        // Advertising
        this.advertise = config.advertise;
        this.broker = RED.nodes.getNode(config.broker);
        this.topic = config.topic ? `${config.topic.toLowerCase().trim('/')}/${this.deviceId}` : null;

        // Capabilities
        this.hasHeating = config.climateType === 'both' || config.climateType === 'heat' || config.climateType === 'manual';
        this.hasCooling = config.climateType === 'both' || config.climateType === 'cool' || config.climateType === 'manual';
        this.hasSetpoint = config.climateType !== 'manual';

        // Previous state
        this.lastChange = null;
        this.lastAction = null;
        this.lastTemp = null;
        this.lastHeatTime = null;
        this.lastCoolTime = null;

        // Handle direct inputs
        this.on("input", function(msg, send, done) {
            if (msg.hasOwnProperty('payload')) { node.mode.set(msg.payload); }
            if (msg.hasOwnProperty('mode')) { node.mode.set(msg.mode); }
            if (msg.hasOwnProperty('boost')) { node.boost.set(msg.boost); }
            if (msg.hasOwnProperty('away')) { node.away.set(msg.away); }
            if (msg.hasOwnProperty('setpoint')) { node.setpoint.set(msg.setpoint); }
            if (msg.hasOwnProperty('temp')) { node.temp.set(msg.temp); }

            node.update();
            done();
        });

        // On node shutdown
        this.on('close', function(removed, done) {
            node.clearUpdateTimeout();
            node.clearBoostTimeout();

            if (node.mqtt) {
                node.mqtt.stop(done);
            } else {
                done();
            }
        });

        // On mqtt message
        this.onMqttSet = function (type, value) {
            if (type === 'mode') { node.mode.set(value); }
            if (type === 'boost') { node.boost.set(value); }
            if (type === 'away') { node.away.set(value); }
            if (type === 'setpoint') { node.setpoint.set(value); }

            node.update();
        }

        // On mqtt advertise
        this.onMqttConnect = function() {
            if (!node.starting) {
                node.publishValues();
            }

            let device = {
                identifiers: [ node.deviceId ],
                name: `${node.name} Climate`,
                model: 'thingZi Climate',
                sw_version: '1.0',
                manufacturer: 'thingZi'
            };

            let climate = {
                name: node.name,
                unique_id: node.deviceId,
                action_topic: `${node.topic}/action`,
                away_mode_state_topic: `${node.topic}/away`,
                away_mode_command_topic: `${node.topic}/away/set`,
                mode_state_topic: `${node.topic}/mode`,
                mode_command_topic: `${node.topic}/mode/set`,
                modes: ['off'],
                device: device
            };

            // Add setpoint config
            if (node.hasSetpoint) {
                climate.temperature_state_topic = `${node.topic}/setpoint`; 
                climate.temperature_command_topic = `${node.topic}/setpoint/set`; 
                climate.current_temperature_topic = `${node.topic}/temp`; 
                climate.initial = node.defaultSetPoint;
                climate.max_temp = node.maxTemp;
                climate.min_temp = node.minTemp;
                climate.temp_step = node.degrees === 'C' ? 0.5 : 1;
                climate.temperature_unit = node.degrees;

                if (node.hasCooling && node.hasHeating) climate.modes.push('auto');
            }

            // Add climate modes
            if (node.hasHeating) climate.modes.push('heat');
            if (node.hasCooling) climate.modes.push('cool');

            return [
                { type: 'climate', payload: climate },
                // { type: 'switch', payload: {
                //     name: `${node.name} Boost`,
                //     unique_id: `${node.deviceId}.boost`,
                //     state_topic: `${node.topic}/boost`,
                //     command_topic: `${node.topic}/boost/set`,
                //     icon: 'mdi:rocket',
                //     payload_on: 'ON',
                //     payload_off: 'OFF',
                //     device: device
                // } },
            ];
        }

        // Get value from storage
        this.getValue = function(id) {
            return node.context().get(id);
        }

        // Set value for storage (mqtt)
        this.setValue = function(id, v) {
            node.context().set(id, v);
            if (node.mqtt) node.mqtt.setValue(id, v);
        }

        // Clear update
        this.clearUpdateTimeout = function() {
            if (node.updateTimeout) {
                clearTimeout(node.updateTimeout);
                node.updateTimeout = null;
            }
        }

        // Clear boost
        this.clearBoostTimeout = function() {
            if (node.boostTimeout) {
                clearTimeout(node.boostTimeout);
                node.boostTimeout = null;
            }
        }

        // Set status message and optionally send via output node
        this.setStatus = function(msg) {
            node.status(msg);
            if (node.sendStatus) {
                node.send([ null, null, { payload: msg }]);
            }
        }

        // Update the node status & send if needed
        this.updateStatus = function(s) {
            let ac = s.pending ? node.lastAction : s.action
            let col = ac === 'heating' ?  'yellow' : ac === 'cooling' ? 'blue' : 'grey';
            let pre = s.pending ? '* ' : ''
            let mode = s.boost !== 'off' ? s.boost + '*' : s.mode;
            let msg = { fill: col, shape:'dot' };

            if (node.hasSetpoint) {
                let set = s.away === 'OFF' ? s.setpoint : 'off';
                msg.text = `${pre}mode=${mode}, set=${set}, temp=${s.temp}`;
            } else {
                msg.text = `${pre}mode=${mode}`;
            }
            
            node.status(msg);
            if (node.sendStatus) {
                node.send([ null, null, { payload: msg, status: s }]);
            }
        }

        this.calcSetpointAction = function(s, now) {
            // Get Current Capability
            let mode = s.boost !== 'off' ? s.boost : s.mode;
            let canHeat = node.hasHeating && (mode === 'auto' || mode === 'heat');
            let canCool = node.hasCooling && (mode === 'auto' || mode === 'cool');
            
            // Use direction of temperature change to improve calculation and reduce ping pong effect
            let isTempRising = node.lastTemp ? s.temp - node.lastTemp > 0.01 : false;
            let isTempFalling = node.lastTemp ? s.temp - node.lastTemp < -0.01 : false;
            let heatPoint = isTempFalling ? s.setpoint + node.tolerance : s.setpoint - node.tolerance;
            let coolPoint = isTempRising ? s.setpoint - node.tolerance : s.setpoint + node.tolerance;

            // Store last temp
            node.lastTemp = s.temp;

            // Calculate what to do based on temp, setpoint and other settings.
            if (canHeat && s.temp < heatPoint) {
                if (!node.lastCoolTime || now.diff(node.lastCoolTime) >= node.swapDelayMs ) {
                    return 'heating';
                }
            } else if (canCool && s.temp > coolPoint) {
                if (!node.lastHeatTime || now.diff(node.lastHeatTime) >= node.swapDelayMs) {
                    return 'cooling';
                }
            }

            return 'off';
        }

        // Update the current action
        this.update = function(isKeepAlive) {
            if (node.starting) {
                return;
            }

            let now = moment();
            node.clearUpdateTimeout();

            // Current Status
            let s = {
                mode: node.mode.get(),
                boost: node.boost.get(),
                setpoint: node.setpoint.get(),
                temp: node.temp.get(),
                tempTime: node.temp.time(),
                away: node.away.get(),
                action: 'off',
                changed: false,
                pending: false
            };

            // Set boost timeout
            if (s.boost !== 'off' && !node.boostTimeout) {
                node.boostTimeout = setTimeout(function() { 
                    node.setValue('boost', 'off');
                    node.update();
                }, node.boostDurationMs);
            }

            if (s.away === 'ON') {
                node.setStatus({fill:'grey', shape:'dot', text:'away'});
                return;
            }

            // Calculate action when setpoint is active
            if (node.hasSetpoint) {
                // Make sure we have a temp value
                let diff = now.diff(s.tempTime);
                if (isNaN(s.temp) || s.temp === undefined || diff >= node.tempValidMs) {
                    node.setStatus({fill:'grey', shape:'dot', text:'waiting for temp...'});
                    return;
                }

                // Away mode must be off
                 s.action = node.calcSetpointAction(s, now);
            } else {
                // Manual set (includes boost)
                let mode = s.boost !== 'off' ? s.boost : s.mode;
                if (mode === 'heat')  s.action = 'heating';
                else if (mode ===  'cool') s.action = 'cooling';
            }

            // Must be a keep alive or change to send message
            s.changed = s.action != node.lastAction;
            if (isKeepAlive || s.changed) {
                // Dont allow changes faster than the cycle time to protect climate systems
                if (node.lastChange) {
                    let diff = now.diff(node.lastChange);
                    if (diff < node.cycleDelayMs) {
                        s.pending = true;
                        node.updateTimeout = setTimeout(node.update, node.cycleDelayMs - diff);
                        node.updateStatus(s);
                        return;
                    }
                }

                // Store states for future checks
                node.lastChange = now;
                node.lastAction = s.action;
                node.setValue('action', s.action);

                // Track last time heating or cooling were on
                let heating = s.action === 'heating';
                let cooling = s.action === 'cooling';

                if (s.changed) {
                    if (heating || s.lastAction === 'heating') node.lastHeatTime = now;
                    if (cooling || s.lastAction === 'cooling') node.lastCoolTime = now;
                }
 
                // Send actions
                node.send([ 
                    { payload: heating ? 'ON' : 'OFF' }, 
                    { payload: cooling ? 'ON' : 'OFF' } 
                ]);
            }

            // Update status
            node.updateStatus(s);

            // Make sure update is called every so often
            if (node.keepAliveMs > 0) {
                node.updateTimeout = setTimeout(function() { node.update(true) }, node.keepAliveMs);
            }
        }

        // Away mode
        function awayStore() {
            this.get = function() { 
                let p = node.getValue('away');
                return p === 'ON' ? 'ON' : 'OFF';
            };
            this.set = function(s) {
                if (s) {
                    node.boost.set('off');
                    s = s.toUpperCase();
                    if (s === 'ON' || s === 'OFF') {
                        node.setValue('away', s);
                    }
                }
            };
        };

        // Mode
        function modeStore() {
            this.get = function() { 
                let m = node.getValue('mode');
                return m === undefined ? 'off' : m;
            };
            this.set = function(s) {
                if (s) {
                    s = s.toLowerCase();
                    if (s === 'on') {
                        node.setValue('mode', 'heat');
                    } else if (s === 'auto' && node.hasSetpoint) {
                        node.setValue('mode', 'auto');
                    } else if ((s === 'heat' && node.hasHeating) || (s === 'cool' && node.hasCooling) || s === 'off') {
                        node.setValue('mode', s);
                    }
                }
            };
        };

        // Boost
        function boostStore() {
            this.get = function() { 
                let b = node.getValue('boost');
                return b === undefined ? 'off' : b;
            };
            this.set = function(s) {
                node.clearBoostTimeout();
                s = s.toLowerCase();
                if (s === 'on') {
                    node.setValue('boost', 'heat');
                } else if (s === 'auto' && node.hasSetpoint) {
                    node.setValue('mode', 'auto');
                } else if ((s === 'heat' && node.hasHeating) || (s === 'cool' && node.hasCooling) || s === 'off') {
                    node.setValue('boost', s);
                }
            };
        };

        // Setpoint
        function setpointStore() {
            this.get = function() { 
                let s = node.getValue('setpoint');
                return s === undefined ? node.defaultSetPoint : s; 
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        t = Math.min(Math.max(t, node.minTemp), node.maxTemp);
                        node.setValue('setpoint', t);
                    }
                }
            };
        };

        // Temp
        function tempStore() {
            this.get = function() { 
                let t = node.getValue('temp');
                return t;
            };
            this.time = function() { 
                let t = node.getValue('time'); 
                return t ? moment(t) : moment();
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        node.setValue('temp', t);
                        node.setValue('time', moment().valueOf());
                    }
                }
            };
        };

        // Init Things
        node.away = new awayStore();
        node.mode = new modeStore();
        node.boost = new boostStore();
        node.setpoint = new setpointStore();
        node.temp = new tempStore();

        // If a broker is specified we create an mqtt handler
        if (node.broker && node.topic) {
            node.mqtt = new mqtt(node.deviceId, node.advertise, node.topic, node.broker, node.onMqttConnect, node.onMqttSet);
        }

        // Initial update
        node.setStatus({fill:'grey', shape:'dot', text:'starting...'});
        setTimeout(function() { 
            node.starting = false;
            node.update(true);
            if (node.mqtt) {
                node.mqtt.setValue('mode', node.mode.get());
                node.mqtt.setValue('boost', node.boost.get());
                node.mqtt.setValue('away', node.away.get());
                if (node.hasSetpoint) {
                    node.mqtt.setValue('setpoint', node.setpoint.get());
                    node.mqtt.setValue('temp', node.temp.get());
                }
            }
        }, 1000);
    });
}
