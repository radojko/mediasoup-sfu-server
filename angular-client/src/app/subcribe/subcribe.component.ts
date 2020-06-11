import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import * as mediasoupClient from "mediasoup-client";

let this$;
@Component({
  selector: 'app-subcribe',
  templateUrl: './subcribe.component.html',
  styleUrls: ['./subcribe.component.scss']
})
export class SubcribeComponent implements OnInit, AfterViewInit, OnDestroy {
  clientId = null;
  device = null;
  consumerTransport = null;
  audioConsumer = null;
  remoteContainer: any;
  isSubcribed = false;
  constructor(private socket: Socket) { }

  ngAfterViewInit(): void {
    this.remoteContainer = document.getElementById('remote_container');
  }
  ngOnDestroy(): void {
    this.socket.disconnect();
  }

  ngOnInit() {
  }

  connectSocket() {
    this$ = this;
    if (this.socket) {
      this.socket.disconnect();
      this.clientId = null;
    }

    return new Promise((resolve, reject) => {
      this.socket.connect();

      this.socket.on('connect', function (evt) {
        console.log('socket.io connected()');
      });
      this.socket.on('error', function (err) {
        console.error('socket.io ERROR:', err);
        reject(err);
      });
      this.socket.on('disconnect', function (evt) {
        console.log('socket.io disconnect:', evt);
      });
      this.socket.on('message', message => {
        console.log('socket.io message:', message);
        if (message.type === 'welcome') {
          if (this$.socket.ioSocket.id !== message.id) {
            console.warn('WARN: something wrong with clientID', this$.socket.ioSocket, message.id);
          }

          this$.clientId = message.id;
          console.log('connected to server. clientId=' + this$.clientId);
          resolve();
        }
        else {
          console.error('UNKNOWN message from server:', message);
        }
      });
      this.socket.on('newProducer', async function (message) {
        console.log('socket.io newProducer:', message);
        if (this$.consumerTransport) {
          // start consume
          this$.audioConsumer = await this$.consumeAndResume(this$.consumerTransport, message.kind);
        }
      });

      this.socket.on('producerClosed', function (message) {
        console.log('socket.io producerClosed:', message);
        const localId = message.localId;
        const remoteId = message.remoteId;
        const kind = message.kind;
        console.log('--try removeConsumer remoteId=' + remoteId + ', localId=' + localId + ', kind=' + kind);

        if (this$.audioConsumer) {
          this$.audioConsumer.close();
          this$.audioConsumer = null;
        }

        if (remoteId) {
          this$.removeRemoteAudio(remoteId);
        } else {
          this$.removeAllRemoteAudio();
        }
      })
    });
  }

  disconnectSocket() {
    if (this.socket) {
      this.socket.disconnect();
      this.clientId = null;
      console.log('socket.io closed..');
      this.isSubcribed = false;
    }
  }

  isSocketConnected() {
    console.log(this.socket);
    if (this.socket.ioSocket.connected) {
      return true;
    }
    else {
      return false;
    }
  }

  sendRequest(type, data) {
    return new Promise((resolve, reject) => {
      this.socket.emit(type, data, (err, response) => {
        if (!err) {
          resolve(response);
        } else {
          reject(err);
        }
      });
    });
  }

  playAudio(element, stream) {
    if (element.srcObject) {
      console.warn('element ALREADY playing, so ignore');
      return;
    }
    element.srcObject = stream;
    element.controls = true;
    element.volume = 0;
    return element.play();
  }

  pauseAudio(element) {
    element.pause();
    element.srcObject = null;
  }

  addRemoteTrack(id, track) {
    let audio = this.findRemoteAudio(id) as any;
    if (!audio) {
      audio = this.addRemoteAudio(id);
    }

    if (audio.srcObject) {
      audio.srcObject.addTrack(track);
      return;
    }

    const newStream = new MediaStream();
    newStream.addTrack(track);
    this.playAudio(audio, newStream)
      .then(() => {
        audio.volume = 1.0
      })
      .catch(err => {
        console.error('media ERROR:', err)
      });
  }

  addRemoteAudio(id) {
    let existElement = this.findRemoteAudio(id);
    if (existElement) {
      console.warn('remoteAudio element ALREADY exist for id=' + id);
      return existElement;
    }

    let element = document.createElement('audio');
    this.remoteContainer.appendChild(element);
    element.id = 'remote_' + id;
    element.controls = true;
    element.volume = 0;
    return element;
  }

  findRemoteAudio(id) {
    let element = document.getElementById('remote_' + id);
    return element;
  }

  removeRemoteAudio(id) {
    console.log(' ---- removeRemoteAudio() id=' + id);
    let element = document.getElementById('remote_' + id) as any;
    if (element) {
      element.pause();
      element.srcObject = null;
      this.remoteContainer.removeChild(element);
    } else {
      console.log('child element NOT FOUND');
    }
  }

  removeAllRemoteAudio() {
    while (this.remoteContainer.firstChild) {
      this.remoteContainer.firstChild.pause();
      this.remoteContainer.firstChild.srcObject = null;
      this.remoteContainer.removeChild(this.remoteContainer.firstChild);
    }
  }

  async subscribe() {
    if (!this.isSocketConnected()) {
      await this.connectSocket().catch(err => {
        console.error(err);
        return;
      });

      // --- get capabilities --
      const data = await this.sendRequest('getRouterRtpCapabilities', {});
      console.log('getRouterRtpCapabilities:', data);
      await this.loadDevice(data);
    }

    // --- prepare transport ---
    console.log('--- createConsumerTransport --');
    const params = await this.sendRequest('createConsumerTransport', {});
    console.log('transport params:', params);
    this.consumerTransport = this.device.createRecvTransport(params);
    console.log('createConsumerTransport:', this.consumerTransport);

    // --- join & start publish --
    this.consumerTransport.on('connect', async ({
      dtlsParameters
    }, callback, errback) => {
      console.log('--consumer trasnport connect');
      this.sendRequest('connectConsumerTransport', {
        dtlsParameters: dtlsParameters
      })
        .then(callback)
        .catch(errback);
    });

    this.consumerTransport.on('connectionstatechange', (state) => {
      switch (state) {
        case 'connecting':
          console.log('subscribing...');
          break;

        case 'connected':
          console.log('subscribed');
          this.isSubcribed = true;
          break;

        case 'failed':
          console.log('failed');
          break;

        default:
          break;
      }
    });

    this.audioConsumer = await this.consumeAndResume(this.consumerTransport, 'audio');
  }

  async consumeAndResume(transport, kind) {
    const consumer = await this.consume(this.consumerTransport, kind);
    if (consumer) {
      console.log('-- do not resume kind=' + kind);
    } else {
      console.log('-- no consumer yet. kind=' + kind);
      return null;
    }
  }

  disconnect() {
    if (this.audioConsumer) {
      this.audioConsumer.close();
      this.audioConsumer = null;
    }
    if (this.consumerTransport) {
      this.consumerTransport.close();
      this.consumerTransport = null;
    }

    this.removeAllRemoteAudio();

    this.disconnectSocket();
  }

  async loadDevice(routerRtpCapabilities) {
    try {
      this.device = new mediasoupClient.Device();
    } catch (error) {
      if (error.name === 'UnsupportedError') {
        console.error('browser not supported');
      }
    }
    await this.device.load({
      routerRtpCapabilities
    });
  }

  async consume(transport, trackKind) {
    console.log('--start of consume --kind=' + trackKind);
    const { rtpCapabilities } = this.device;
    const data = await this.sendRequest('consume', {
      rtpCapabilities: JSON.stringify(rtpCapabilities),
      kind: trackKind
    }).catch(err => {
      console.error('consume ERROR:', err);
    });

    const dataAs = data as any;
    const producerId = dataAs.producerId;
    const id = dataAs.id;
    const kind = dataAs.kind;
    const rtpParameters = dataAs.rtpParameters;

    if (producerId) {
      let codecOptions = {};
      const consumer = await transport.consume({
        id,
        producerId,
        kind,
        rtpParameters,
        codecOptions,
      });

      this.addRemoteTrack(this.clientId, consumer.track);
 
      console.log('--end of consume');

      return consumer;
    } else {
      console.warn('--- remote producer NOT READY');

      return null;
    }
  }

}
