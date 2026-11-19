'use strict';

const processLib = require('../lib/process.cjs');
const info = processLib.getZcodeInfo();
console.log(JSON.stringify(info, null, 2));
