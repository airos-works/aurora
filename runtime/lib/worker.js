'use strict';

// A worker thread of the main process or of a utility process: required
// before the worker's own script (node-setup.js installWorkerSetup puts it
// in the worker's execArgv). The worker gets what applyAppOverrides gave its
// parent: the app's platform and executable path (from the environment the
// worker inherits), native module stand-ins, fs.watch, the newer Node.js
// globals of compat.js, and the same for workers it starts.

require('./node-setup').applyAppOverrides();
