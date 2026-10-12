const API_URL = 'https://script.google.com/macros/s/AKfycbxyMRYjANF1zyENakj_u27VqYq7DDO11mEwG5EgJrdkUskNty-azjNHGS-8qw2gUxB-/exec';
const HUB_API_URL =
  'https://script.google.com/macros/s/AKfycbyAHpUfM1RrPJbamCVcc5rGhUgRKoLRKSULBGnCNGLyCSaFU5lp7SX2Ge1Wwv9YEV5-Sg/exec';
const HUB_URL = '/hub/';
const SHARED_AUTH_TOKEN_KEY = 'tools501_google_id_token';
const TWO_FACTOR_CHECK_ENABLED = false;
const REQUEST_TIMEOUT_MS = 25000;
const WRITE_REQUEST_TIMEOUT_MS = 60000;
const LONG_READ_REQUEST_TIMEOUT_MS = 60000;
const LONG_READ_PROJECT_ACTIONS = new Set([
  'bootstrap',
  'getBookPeople',
  'getPeople',
  'getIcsUsers',
  'getDiagram'
]);
const LONG_PROJECT_ACTIONS = new Set([
  'createIcs',
  'updateIcs',
  'deleteIcs',
  'createIcsUser',
  'updateIcsUser',
  'deleteIcsUser'
]);
const TOKEN_EXPIRY_SAFETY_MS = 2 * 60 * 1000;
const MOBILE_VIEWPORT_QUERY = '(max-width: 760px)';
const ICS_REGISTRY_TAB_ID = 'ics-registry';
const PEOPLE_ICS_TAB_ID = 'people-ics';
