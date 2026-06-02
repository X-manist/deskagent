'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: (s) => ipcRenderer.invoke('app:saveSettings', s),
  send: (text, attachments, threadId) => ipcRenderer.invoke('chat:send', { text, attachments, threadId }),
  pickAttachments: (kind) => ipcRenderer.invoke('app:pickAttachments', kind),
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
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
