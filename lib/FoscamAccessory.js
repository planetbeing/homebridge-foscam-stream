"use strict";

const FoscamStream = require('./FoscamStream');
const Foscam = require('foscam-client');

class FoscamAccessory {
    constructor(hap, config, log) {
        let self = this;
        const StreamController = hap.StreamController;

        self.hap = hap;
        self.log = log;

        let username = config.username || 'admin';
        let password = config.password || '';
        let port = config.port || 88;
        let uri = 'rtsp://' + username + ':' + password + '@' + config.host + ':' + port + '/';
        let gain = config.gain || 0;
        let maxMainStreams = config.maxMainStreams === undefined ? 2 : config.maxMainStreams;
        let maxSubStreams = config.maxSubStreams === undefined ? 2 : config.maxSubStreams;
        let speaker = config.speaker === undefined ? {} : config.speaker;

        self.streamType = config.streamType === undefined ? 3 : config.streamType;
        self._motionDetected = false;
        self._motionDetectedCharacteristic = null;

        self._foscamClient = new Foscam({
            username: username,
            password: password,
            host: config.host,
            port: port,
            protocol: 'http'
        });

        self.log('FoscamAccessory configured with', username, config.host, port, self.streamType);

        let mainURI = uri + 'videoMain';
        let subURI = uri + 'videoSub';

        let mainResolutions = [
            [1280, 960, 30],
            [1280, 960, 15],
            [1280, 720, 30],
            [1280, 720, 15],
            [640, 480, 30],
            [640, 480, 15],
            [640, 360, 30],
            [640, 360, 15],
            [320, 240, 30],
            [320, 240, 15],
            [320, 180, 30],
            [320, 180, 15]
        ];

        let subResolutions = [
            [1280, 720, 10],
            [640, 480, 10],
            [640, 360, 10],
            [320, 240, 10],
            [320, 180, 10]
        ];

        let audioSettings = {
            codecs: [
                {
                    type: 'OPUS',
                    samplerate: 16
                }
            ]
        };

        let videoCodec = {
            profiles: [StreamController.VideoCodecParamProfileIDTypes.MAIN],
            levels: [StreamController.VideoCodecParamLevelTypes.TYPE3_1, StreamController.VideoCodecParamLevelTypes.TYPE3_2, StreamController.VideoCodecParamLevelTypes.TYPE4_0]
        }

        let mainOptions = {
            proxy: true,
            disable_audio_proxy: true,
            srtp: false,
            video: {
                resolutions: mainResolutions,
                codec: videoCodec
            },
            audio: audioSettings
        };

        let subOptions = {
            proxy: true,
            disable_audio_proxy: true,
            srtp: false,
            video: {
                resolutions: subResolutions,
                codec: videoCodec
            },
            audio: audioSettings
        };

        self.mainSupportedBitRates = [
            4 * 1024 * 1024,
            2 * 1024 * 1024,
            1 * 1024 * 1024,
            512 * 1024,
            256 * 1024,
            200 * 1024,
            128 * 1024,
            100 * 1024
        ];

        self.subSupportedBitRates = [
            512 * 1024,
            256 * 1024,
            200 * 1024,
            128 * 1024,
            100 * 1024,
            50 * 1024,
            20 * 1024
        ];

        self.services = [];
        self.streamControllers = [];
        self.streams = [];

        self._streamControllerIdx = 0;
        self._createStreamControllers(maxMainStreams, mainURI, gain, speaker, mainOptions, self.setMainOptions.bind(self));
        self._createStreamControllers(maxSubStreams, subURI, gain, speaker, subOptions, self.setSubOptions.bind(self));

        if(config.motionDetector) {
            self._configureMotionDetector(config.motionDetector);
            self._pollForMotionDetected();
            self._createMotionDetectorService();
        }

        self._infoPromise = self._foscamClient.getDevInfo().then(info => {
            self.log('Foscam Camera Info:', info);
            return info;
        });
    }

    info() {
        let self = this;
        return self._infoPromise;
    }

    closestBitRate(list, bitRate) {
        let closest = null;
        let closestDiff;
        for(let rate of list) {
            let diff = Math.abs(bitRate - rate);
            if(closest === null || closestDiff > diff) {
                closest = rate;
                closestDiff = diff;
            }
        }

        return closest;
    }

    setMainOptions(width, height, fps, bitRate) {
        let self = this;
        self.log('Requested main options:', width, height, fps, bitRate);
        return self._foscamClient.setVideoStreamParam({
            'streamType': self.streamType,
            'resolution': self.heightToFoscamResolution(height),
            'bitRate': self.closestBitRate(self.mainSupportedBitRates, bitRate),
            'frameRate': fps,
            'GOP': fps,
            'isVBR': true
        }).then(() => {
            self.log('Set main parameters, requesting set type.');
            return self._foscamClient.setMainVideoStreamType(self.streamType);
        });
    }

    setSubOptions(width, height, fps, bitRate) {
        let self = this;
        self.log('Requested sub options:', width, height, fps, bitRate);
        return self._foscamClient.setSubVideoStreamParam({
            'streamType': self.streamType,
            'resolution': self.heightToFoscamResolution(height),
            'bitRate': self.closestBitRate(self.subSupportedBitRates, bitRate),
            'frameRate': fps,
            'GOP': fps,
            'isVBR': true
        }).then(() => {
            // Work-around for lack of setSubVideoStreamType in foscam-client.
            self.log('Set sub parameters, requesting set type.');
            return self._foscamClient.get('setSubVideoStreamType', {'streamType': self.streamType});
        });
    }

    heightToFoscamResolution(height) {
        switch(height) {
            case 960:
                return 6;
            case 720:
                return 0;
            case 480:
                return 1;
            case 360:
                return 3;
            case 240:
                return 2;
            case 180:
                return 4;
        }
    }

    _createStreamControllers(numStreams, uri, gain, speaker, options, setOptions) {
        let self = this;

        for(let i = 0; i < numStreams; i++) {
            let stream = new FoscamStream(uri, gain, speaker, setOptions, self.log);
            let streamController = new self.hap.StreamController(self._streamControllerIdx++, options, stream);
            stream.streamController = streamController;

            self.services.push(streamController.service);
            self.streamControllers.push(streamController);
            self.streams.push(stream);
        }
    }

    handleSnapshotRequest(request, callback) {
        let self = this;
        self.log('Foscam-NG: Getting snapshot.');
        self._foscamClient.snapPicture2().then(function(data) {
            self.log('Foscam-NG: Got snapshot.');
            callback(null, data);
        });
    }

    _configureMotionDetector(config) {
        let self = this;

        let activeDays;
        let activeAreas;

        if(config['schedule']) {
            activeDays = [0, 0, 0, 0, 0, 0, 0];
            let schedule = config['schedule'];
            let generateBitMapForDay = (config, activeDays, day, idx) => {
                if(!config[day])
                    return;

                let bits = 0;

                for(let interval of config[day]) {
                    let start = interval[0].split(':');
                    let stop = interval[1].split(':');
                    if(start.length != 2)
                        throw {message: 'Bad interval specifier', specifier: start};

                    if(stop.length != 2)
                        throw {message: 'Bad interval specifier', specifier: stop};

                    let startBit = parseInt(start[0]) * 2 + (parseInt(start[1]) / 30);
                    if(startBit < 0 || startBit > 48)
                        throw {message: 'Time out of range', specifier: start};

                    let stopBit = parseInt(stop[0]) * 2 + (parseInt(stop[1]) / 30);
                    if(stopBit < 0 || stopBit > 48)
                        throw {message: 'Time out of range', specifier: stop};

                    if(startBit == stopBit)
                        throw {message: 'Interval too small', specifier: interval};

                    for(let i = startBit; i < stopBit; ++i) {
                        if(i >= 32)
                            bits += ((1 << (i - 32)) >>> 0) * 0x100000000;
                        else
                            bits += (1 << i) >>> 0;
                    }
                }

                activeDays[idx] = bits;
            }

            generateBitMapForDay(schedule, activeDays, 'monday', 0);
            generateBitMapForDay(schedule, activeDays, 'tuesday', 1);
            generateBitMapForDay(schedule, activeDays, 'wednesday', 2);
            generateBitMapForDay(schedule, activeDays, 'thursday', 3);
            generateBitMapForDay(schedule, activeDays, 'friday', 4);
            generateBitMapForDay(schedule, activeDays, 'saturday', 5);
            generateBitMapForDay(schedule, activeDays, 'sunday', 6);
        } else {
            let allDay = (((1 << (48 - 32)) >>> 0) * 0x100000000) - 1;
            activeDays = [allDay, allDay, allDay, allDay, allDay, allDay, allDay];
        }

        if(config['areas']) {
            activeAreas = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            for(let area of config['areas']) {
                let topLeft = area[0];
                let bottomRight = area[1];

                if(topLeft[0] < 0 || topLeft[0] > 9 || topLeft[1] < 0 || topLeft[1] > 9)
                    throw {message: 'Coordinates out of bounds', coordinates: topLeft};

                if(topLeft[0] > bottomRight[0] || bottomRight[0] > 9 || topLeft[1] > bottomRight[1] || bottomRight[1] > 9)
                    throw {message: 'Coordinates out of bounds', coordinates: topLeft};

                for(let y = topLeft[1]; y <= bottomRight[1]; ++y) {
                    for(let x = topLeft[0]; x <= bottomRight[0]; ++x) {
                        activeAreas[y] = (activeAreas[y] | (1 << x)) >>> 0;
                    }
                }
            }
        } else {
            let allRow = ((1 << 10) - 1) >>> 0;
            activeAreas = [allRow, allRow, allRow, allRow, allRow, allRow, allRow, allRow, allRow, allRow];
        }

        let triggerInterval = config.triggerInterval === undefined ? 5 : config.triggerInterval;
        if(triggerInterval < 5 || triggerInterval > 15)
            throw  {message: 'Trigger interval out of range', triggerInterval: triggerInterval};

        let params = {
            'isEnable': true,
            'linkage': 0,
            'snapInterval': config.snapInterval === undefined ? 0 : config.snapInterval,
            'sensitivity': config.sensitivity === undefined ? 1 : config.sensitivity,
            'triggerInterval': triggerInterval - 5
        };

        for(let i = 0; i < 7; ++i)
            params['schedule' + i.toString()] = activeDays[i];

        for(let i = 0; i < 10; ++i)
            params['area' + i.toString()] = activeAreas[i];

        self.log('FoscamAccessory: New motion detect params:', params);
        return self._foscamClient.setMotionDetectConfig(params);
    }

    _pollForMotionDetected() {
        let self = this;
        self._foscamClient.getDevState().then(state => {
            let detected = state['motionDetectAlarm'] == 2;
            self._motionDetected = detected;

            if(self._motionDetectedCharacteristic)
                self._motionDetectedCharacteristic.setValue(self._motionDetected);

            setTimeout(() => {
                self._pollForMotionDetected();
            }, 1000);
        });
    }

    _createMotionDetectorService() {
        let self = this;
        let service = new self.hap.Service.MotionSensor();

        self._motionDetectedCharacteristic = service.getCharacteristic(self.hap.Characteristic.MotionDetected);

        self._motionDetectedCharacteristic.on('get', callback => {
            callback(null, self._motionDetected);
        });

        self.services.push(service);
    }
}

module.exports = FoscamAccessory;
