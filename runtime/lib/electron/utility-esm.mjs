// import ... from 'electron' in a utility process.

import { createRequire } from 'module';

const electron = createRequire(import.meta.url)('./utility.js');

export default electron;
export const MessageChannelMain = electron.MessageChannelMain;
export const MessagePortMain = electron.MessagePortMain;
export const net = electron.net;
export const systemPreferences = electron.systemPreferences;
