"use strict";

const EventEmitter = require('events').EventEmitter;
const ip = require('ip');
const crypto = require('crypto');
const RTPG711Transcoder = require('./RTPG711Transcoder');
const RTSPClient = require('./RTSPClient');
const FoscamBinaryClient = require('foscam-binary-client');

class FoscamStream extends EventEmitter {
    constructor(uri, gain, speaker, setOptions, log) {
        super();
        let self = this;

        self.log = log;

        self.uri = uri;
        self.gain = gain;
        self.setOptions = setOptions;

        self.rtspClient = new RTSPClient(uri);
        self.streamController = null;

        self.speakerEnabled = speaker.enabled === undefined ? true : speaker.enabled;
        self.speakerCompression = speaker.compression === undefined ? true : speaker.compression;
        self.speakerGain = speaker.gain === undefined ? 1 : Math.pow(10, speaker.gain / 20);

        self.rtspClient.on('error', (err) => {
            self.log('FoscamStream: error:', err);
            if(self.streamController)
                self.streamController.forceStop();
        });

        self._readyPromise = self.rtspClient.sdp().then(() => {
            self.log('FoscamStream: RTSPClient got sdp.');
            if(self.rtspClient.audio.codec == 'PCMU') {
                self.transcoderClass = RTPG711Transcoder;
            }

            return;
        });

        self.foscamStream = null;
        self.audioBuffer = null;
        self.audioOutputBuffer = null;
    }

    ready() {
        return self._readyPromise;
    }

    prepareStream(request, callback) {
        let self = this;

        if(self.speakerEnabled) {
            if(self.foscamStream)
                self.foscamStream.close();

            self.foscamStream = new FoscamBinaryClient.FoscamStreamLayer(self.rtspClient.hostname, self.rtspClient.port, self.rtspClient.username, self.rtspClient.password);
            self.audioBuffer = null;
            self.audioOutputBuffer = null;
            self.foscamStream.startTalkStream().then(() => {
                self.talkStreamSetup = true;
            }).catch(() => {
                self.talkStreamSetup = false;
            });
        }

        let options = {
            'outgoing': {
                'address': request['audio']['targetAddress'],
                'port': request['audio']['port'],
                'ssrc': crypto.randomBytes(4).readUInt32LE(0),
            },

            'gain': self.gain,

            'audio-data': self.audioDataInput.bind(self)
        };

        self.transcoder = new self.transcoderClass(options);

        self.transcoder.start().then(() => {
            return self.rtspClient.setup(self.rtspClient.video.uri, request['video']['proxy_rtp'], request['video']['proxy_rtcp']).then(function(video) {
                return self.rtspClient.setup(self.rtspClient.audio.uri, self.transcoder.incomingLocalRTPPort(), self.transcoder.incomingLocalRTCPPort()).then(function(audio) {
                    return [video, audio];
                });
            });
        }).then(function(settings) {
            let videoSettings = settings[0];
            let audioSettings = settings[1];

            self.transcoder.incomingAddress = audioSettings.source;
            self.transcoder.incomingRTPPort = audioSettings.rtpPort;
            self.transcoder.incomingRTCPPort = audioSettings.rtcpPort;

            let currentAddress = ip.address();
            let response = {
                'address': {
                    'address': currentAddress,
                    'type': ip.isV4Format(currentAddress) ? 'v4' : 'v6'
                },
                'video': {
                    'proxy_pt': self.rtspClient.video.payload,
                    'proxy_server_address': videoSettings.source,
                    'proxy_server_rtp': videoSettings.rtpPort,
                    'proxy_server_rtcp': videoSettings.rtcpPort
                },
                'audio': {
                    'address': currentAddress,
                    'port': self.transcoder.outgoingLocalPort(),
                    'ssrc': self.transcoder.outgoingSSRC
                }
            };

            self.log('Video: ' + self.rtspClient.video.uri + ' -> ' + currentAddress + ': RTP ' + videoSettings.rtpPort.toString() + ' -> ' + request['video']['proxy_rtp'].toString() + ' / RTCP ' + videoSettings.rtcpPort.toString() + ' -> ' + request['video']['proxy_rtcp'].toString());
            self.log('Audio: ' + self.rtspClient.audio.uri + ' -> ' + currentAddress + ': RTP ' + audioSettings.rtpPort.toString() + ' -> ' + self.transcoder.incomingLocalRTPPort().toString() + ' / RTCP ' + audioSettings.rtcpPort.toString() + ' -> ' + self.transcoder.incomingLocalRTCPPort().toString() + ' => ' + self.transcoder.outgoingLocalPort().toString() + ' -> ' + self.transcoder.outgoingPort.toString());

            callback(response);
        }).catch((err) => {
            self.log('FoscamStream:', err);
        });
    }

    handleStreamRequest(request) {
        let self = this;
        let requestType = request['type'];
        if(requestType == 'start') {
            self.log('Play: ' + self.uri);

            self.transcoder.setOutgoingSampleRate(request['audio']['sample_rate'] * 1000);
            self.transcoder.outgoingPacketTime = request['audio']['packet_time'];
            self.transcoder.outgoingPayloadType = request['audio']['pt'];

            self.setOptions(request['video']['width'], request['video']['height'], request['video']['fps'], request['video']['max_bit_rate'] * 1000)
                .then(() => {
                    return self.rtspClient.play();
                })
                .catch(err => {
                    self.log('FoscamStream:', err);
                    if(self.streamController) self.streamController.forceStop();
                });

            return;
        } else if(requestType == 'reconfigure') {
            self.log('Reconfigure: ', request);
            self.setOptions(request['video']['width'], request['video']['height'], request['video']['fps'], request['video']['max_bit_rate'] * 1000)
                .catch(err => {
                    self.log('FoscamStream:', err);
                    if(self.streamController) self.streamController.forceStop();
                });
        } else if(requestType == 'stop') {
            self.log('Stop: ' + self.uri);
            self.rtspClient.teardown();
            if(self.speakerEnabled) {
                if(self.foscamStream)
                    self.foscamStream.close();
                self.foscamStream = null;
                self.audioBuffer = null;
                self.audioOutputBuffer = null;
                self.talkStreamSetup = false;
            }
        }

        return null;
    }

    resample(samples, inputRate, outputRate) {
        let self = this;
        if(inputRate > outputRate) {
            let divider = inputRate / outputRate;
            if(Math.floor(divider) != divider)
                throw {message: 'Cannot evenly resample.'};

            let increment = divider * 2;

            let output = Buffer.alloc(2 * Math.floor(samples.length / increment));
            let cursor = 0;
            let i;
            for(i = 0; i <= (samples.length - increment); i += increment) {
                let sum = 0;
                for(let j = 0; j < divider; ++j) {
                    sum += samples.readInt16LE(i + (j * 2));
                }

                let sample = Math.round(sum / divider * self.speakerGain);
                if(sample > 0x7fff)
                    sample = 0x7fff;
                else if(sample < -0x7fff)
                    sample = -0x7fff;

                output.writeInt16LE(sample, cursor);
                cursor += 2;
            }

            return [output, samples.slice(i)];
        } else if(inputRate < outputRate) {
            let multiplier = outputRate / inputRate;
            if(Math.floor(multiplier) != multiplier)
                throw {message: 'Cannot evenly resample.'};

            let output = Buffer.alloc(samples.length * multiplier);
            let cursor = 0;
            for(let i = 0; i < samples.length; i += 2) {
                let sample = samples.readInt16LE(i);

                for(let j = 0; j < multiplier; ++j) {
                    output.writeInt16LE(sample, cursor);
                    cursor += 2;
                }
            }

            return [output, null];
        }

        return [samples, null];
    }

    audioDataInput(samples) {
        let self = this;
        if(!self.talkStreamSetup)
            return;

        if(self.audioBuffer && self.audioBuffer.length > 0)
            samples = Buffer.concat([self.audioBuffer, samples]);

        let results = self.resample(samples, self.transcoder.outgoingSampleRate, 8000);
        self.audioBuffer = results[1];

        let output;
        if(self.audioOutputBuffer)
            output = Buffer.concat([self.audioOutputBuffer, results[0]]);
        else
            output = results[0];

        self.audioOutputBuffer = output;

        if(output.length < 960)
            return;

        // Foscam appears to be hardcoded for 60 ms, 8000 kHz.
        let current = output.slice(0, 960);
        if(output.length > 960)
            self.audioOutputBuffer = output.slice(960);
        else
            self.audioOutputBuffer = null;

        self.foscamStream.sendTalkData(current, self.speakerCompression);
    }
}

module.exports = FoscamStream;
