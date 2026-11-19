'use strict';

const fs = require('fs');

const { fail } = require('./errors.cjs');
const credentials = require('./credentials.cjs');
const paths = require('./paths.cjs');

function readOnboarding(credentialsFile) {
  const file = paths.onboardingFile(credentialsFile);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file, exists: false, value: null, error: null };
    return { file, exists: false, value: null, error: error.message };
  }
  try {
    return { file, exists: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { file, exists: true, value: null, error: error.message };
  }
}

function getDeviceMid(credentialsFile) {
  const record = readOnboarding(credentialsFile);
  const value = record.value;
  if (!value || typeof value !== 'object') return null;
  const mid = value.deviceMid;
  return typeof mid === 'string' && mid.trim() ? mid.trim() : null;
}

function setDeviceMid(credentialsFile, deviceMid) {
  if (typeof deviceMid !== 'string' || !deviceMid.trim()) {
    fail('USAGE', 'deviceMid 必须是非空字符串');
  }
  if (deviceMid.length > 256) {
    fail('USAGE', 'deviceMid 过长');
  }
  const file = paths.onboardingFile(credentialsFile);
  const record = readOnboarding(credentialsFile);
  if (record.exists && record.error) {
    fail('CORRUPT_CREDENTIALS', `onboarding-record.json 不是有效 JSON，拒绝覆盖：${file}`);
  }
  const value = record.value && typeof record.value === 'object' ? { ...record.value } : {
    version: 2,
    entries: [],
    decisions: [],
  };
  value.deviceMid = deviceMid.trim();
  credentials.writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return { file, deviceMid: value.deviceMid };
}

module.exports = {
  readOnboarding,
  getDeviceMid,
  setDeviceMid,
};
