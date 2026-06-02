'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: (s) => ipcRenderer.invoke('app:saveSettings', s),
  send: (text, attachments, threadId) => ipcRenderer.invoke('chat:send', { text, attachments, threadId }),
  pickAttachments: (kind) => ipcRenderer.invoke('app:pickAttachments', kind),
  downloadAttachment: (url) => ipcRenderer.invoke('app:downloadAttachment', url),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return file && file.path ? file.path : '';
    }
  },
  interrupt: (threadId) => ipcRenderer.invoke('chat:interrupt', threadId),
  listSessions: () => ipcRenderer.invoke('chat:listSessions'),
  newSession: () => ipcRenderer.invoke('chat:newSession'),
  resumeSession: (threadId) => ipcRenderer.invoke('chat:resumeSession', threadId),
  openWorkspace: () => ipcRenderer.invoke('app:openWorkspace'),
  remote: {
    status: () => ipcRenderer.invoke('remote:status'),
    refreshPairing: () => ipcRenderer.invoke('remote:refreshPairing'),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    sendSms: (phone) => ipcRenderer.invoke('auth:sendSms', phone),
    verifySms: (phone, code) => ipcRenderer.invoke('auth:verifySms', { phone, code }),
    me: () => ipcRenderer.invoke('auth:me'),
    packages: () => ipcRenderer.invoke('auth:packages'),
    createOrder: (package_id, provider) => ipcRenderer.invoke('auth:createOrder', { package_id, provider }),
    confirmOrder: (outTradeNo) => ipcRenderer.invoke('auth:confirmOrder', outTradeNo),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  on: (channel, cb) => {
    const allowed = [
      'engine:status',
      'engine:log',
      'chat:delta',
      'chat:message',
      'chat:activity',
      'chat:turnDone',
      'chat:error',
      'chat:turnState',
      'chat:threadChanged',
      'chat:historyLoaded',
      'auth:state',
      'remote:state',
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
