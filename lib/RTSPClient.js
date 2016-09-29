"use strict";

const EventEmitter = require('events').EventEmitter;
const net = require('net');
const rtsp = require('rtsp-stream');
const url = require('url');
const www_authenticate = require('www-authenticate');
const SDPTransform = require('sdp-transform');
const dns = require('dns');
const ip = require('ip');

class RTSPClient extends EventEmitter {
  constructor(urlString) {
    super();
    let self = this;

    let parsed = url.parse(urlString);

    let auth = parsed.auth;
    parsed.auth = null;

    let authParts = auth.split(':', 2);
    self.username = authParts[0];
    self.password = authParts[1];
    self.authenticate = www_authenticate(self.username, self.password);
    self.authenticator = null;

    self.hostname = parsed.hostname;
    self.port = parsed.port || 554;

    self.sanitizedURI = url.format(parsed);

    self.requests = {};
    self.cseq = 1;
    self.session = null;
    self.keepAliveInterval = null;
    self.keepAliveIntervalMsecs = 5000;
    self.pendingReconnect = null;

    self.sdpPromise = self.reconnect().then(() => {
      return self.getSDP();
    });
  }

  reconnect() {
    let self = this;
    if(self.pendingReconnect)
      return self.pendingReconnect;

    self.pendingReconnect = new Promise((resolve, reject) => {
      self.decoder = new rtsp.Decoder();
      self.encoder = new rtsp.Encoder();

      self.socket = net.createConnection(self.port, self.hostname, function() {
        self.pendingReconnect = null;
        resolve();
      });

      self.socket.on('error', (err) => {
        self.pendingReconnect = null;
        self.onError(err);
      });

      self.socket.pipe(self.decoder);
      self.encoder.pipe(self.socket);

      self.decoder.on('response', function(response) {
        self.onResponse(response);
      });

      self.decoder.on('error', self.onError.bind(self));
    });

    return self.pendingReconnect;
  }

  sdp() {
    let self = this;
    return self.sdpPromise;
  }

  onError(err) {
    let self = this;
    for(let key in self.requests) {
      let request = self.requests[key];
      if(!request)
        continue;

      request.reject(err);
      delete self.requests[key];
    }

    self.reconnect();
  }

  onResponse(response) {
    let self = this;
    let cseq = parseInt(response.headers['cseq']);
    let request = self.requests[cseq];
    if(!request)
      return;

    request.chunks = [];
    response.on('data', function(data) {
      request.chunks.push(data);
    });

    let done = function() {
      let requestOptions = request.options;
      let resolve = request.resolve;
      let reject = request.reject;

      delete self.requests[cseq];

      if(response.statusCode == 401 && !requestOptions.headers['Authorization'] && response.headers['www-authenticate']) {
        self.authenticator = self.authenticate(response.headers['www-authenticate']);
        if(self.authenticator.err) {
          reject({message: self.authenticator.err, type: 'authentication'});
          return;
        }

        resolve(self.makeRequest(requestOptions));
        return;
      } else if((response.statusCode == 401 || response.statusCode == 403) && requestOptions.headers['Authorization']) {
        reject({message: 'Authentication failed.', type: 'authentication'});
        return;
      }

      resolve({response: response, data: Buffer.concat(request.chunks)});
    };

    if(response.headers['session']) {
      let parts = response.headers['session'].split(';');
      self.newSession(parts[0]);
    }

    if(response.headers['content-length'] && parseInt(response.headers['content-length']) > 0)
      response.on('end', done);
    else
      done();
  }

  makeRequest(options) {
    return new Promise((resolve, reject) => {
      let self = this;
      let cseq = self.cseq++;

      if(!options.headers)
        options.headers = {};

      options.headers['CSeq'] = cseq;
      if(self.authenticator)
        options.headers['Authorization'] = self.authenticator.authorize(options.method, options.uri);

      if(self.session && !options.headers['Session'])
        options.headers['Session'] = self.session;

      let request = self.encoder.request(options);
      self.requests[cseq] = {options: options, resolve: resolve, reject: reject};
      request.end();
    });
  }

  codecForPayload(payload) {
    switch(payload) {
      case 0:
        return 'PCMU';
      case 8:
        return 'PCMA';
      default:
        return 'UNKNOWN';
    }
  }

  getSDP() {
    let self = this;
    return self.makeRequest({method: 'DESCRIBE', uri: self.sanitizedURI}).then(result => {
      let response = result.response;
      let data = result.data;

      let sdp = SDPTransform.parse(data.toString('utf8'));
      for(let medium of sdp.media) {
        let payloads = medium.payloads.toString().split(' ');
        let payload = parseInt(payloads[0]);

        let codec;
        if(payload >= 96) {
          for(let rtp of medium.rtp) {
            if(rtp.payload == payload && rtp.codec) {
              codec = rtp.codec;
              break;
            }
          }
        } else {
          codec = self.codecForPayload(payload);
        }

        let uri;
        if(medium.control) {
          uri = url.resolve(self.sanitizedURI + '/', medium.control);
        } else {
          uri = self.sanitizedURI;
        }

        let descriptor = {
          payload: payload,
          codec: codec,
          uri: uri
        };

        if(medium.type == 'video' && !self.video) {
          self.video = descriptor;
        }

        if(medium.type == 'audio' && !self.audio) {
          self.audio = descriptor;
        }
      }

      return sdp;
    }).catch((err) => {
      if(err && err.type && err.type == 'authentication')
        return Promise.reject(err);

      // Try again after reconnect if it isn't authentication related.
      return self.reconnect().then(() => {
        return self.getSDP();
      });
    });
  }

  setup(uri, rtpPort, rtcpPort) {
    let self = this;
    return self.makeRequest({
      method: 'SETUP',
      uri: uri,
      headers: {
        'Transport': 'RTP/AVP;unicast;client_port=' + rtpPort.toString() + '-' + rtcpPort.toString()
      }
    }).then(result => {
      let response = result.response;
      let data = result.data;

      let transport = response.headers['transport'];
      if(!transport)
        return Promise.reject({ message: 'No transport.', response: response });

      let source = null;
      let rtpPort = null;
      let rtcpPort = null;

      for(let value of transport.split(';')) {
        let parts = value.split('=', 2);
        if(parts.length != 2)
          continue;

        if(parts[0] == 'server_port') {
          let ports = parts[1].split('-', 2);
          rtpPort = parseInt(ports[0]);
          if(ports.length == 2)
            rtcpPort = parseInt(ports[1]);
          else
            rtcpPort = rtpPort;
        } else if(parts[0] == 'source') {
          source = parts[1];
        }
      }

      if(source && rtpPort && rtcpPort) {
        if(ip.isV4Format(source) || ip.isV6Format(source)) {
          return {
            source,
            rtpPort,
            rtcpPort
          };
        } else {
          return new Promise((resolve, reject) => {
            dns.resolve(source, function(err, addresses) {
              if(err || addresses.length == 0) {
                return Promise.reject({ message: 'Could not resolve source.', source: source });
              }

              resolve({
                source: addresses[0],
                rtpPort: rtpPort,
                rtcpPort: rtcpPort
              });
            });
          });
        }
      } else {
        return Promise.reject({ message: 'Could not parse transport.', transport: transport, source: source, rtpPort: rtpPort, rtcpPort: rtcpPort });
      }
    });
  }

  play() {
    let self = this;
    return self.makeRequest({
      method: 'PLAY',
      uri: self.sanitizedURI
    });
  }

  pause() {
    let self = this;
    return self.makeRequest({
      method: 'PAUSE',
      uri: self.sanitizedURI
    });
  }

  teardown() {
    let self = this;
    let promise = self.makeRequest({
      method: 'TEARDOWN',
      uri: self.sanitizedURI,
      headers: {
        'Session': self.session
      }
    });

    self.closeSession();
    return promise;
  }

  ping() {
    let self = this;
    return self.makeRequest({
      method: 'GET_PARAMETER',
      uri: self.sanitizedURI
    });
  }

  newSession(session) {
    let self = this;
    self.session = session;
    if(self.keepAliveInterval)
      clearInterval(self.keepAliveInterval);

    self.keepAliveInterval = setInterval(function() {
      self.ping().catch((err) => {
        self.emit(err);
      });
    }, self.keepAliveIntervalMsecs);
  }

  closeSession() {
    let self = this;
    self.session = null;
    if(self.keepAliveInterval)
      clearInterval(self.keepAliveInterval);
  }

}

module.exports = RTSPClient;
