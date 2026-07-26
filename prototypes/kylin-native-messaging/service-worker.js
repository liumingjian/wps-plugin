// PROTOTYPE: automatically exercises the browser-to-host boundary when loaded.
const HOST = 'com.liumingjian.wps_edit_agent';

const requests = [
  {
    version: 1,
    type: 'ping',
    taskId: 'kylin-native-messaging-ping',
    documentId: 'doc-001'
  },
  {
    version: 1,
    type: 'task-probe',
    taskId: 'kylin-native-messaging-task',
    documentId: 'doc-001'
  }
];

async function runProbe() {
  for (const request of requests) {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(HOST, request, (reply) => {
        resolve(chrome.runtime.lastError
          ? { status: 'failed', message: chrome.runtime.lastError.message }
          : reply);
      });
    });
    console.log('Kylin Native Messaging prototype', { request, response });
  }
}

runProbe();
