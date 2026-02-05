const REAL_API_BASE = 'https://web.realsports.io';
const REAL_VERSION = '27';
const REAL_REFERER = 'https://realsports.io/';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DEFAULT_SEC_CH_UA = '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"';
const DEVICE_NAME = 'Chrome on Windows';

let cachedDeviceUUID = null;

const keepUnique = (content) => [...new Set(content)];
const withoutChars = (chars, charsToExclude) => chars.filter((char) => !charsToExclude.includes(char));
const onlyChars = (chars, keepChars) => chars.filter((char) => keepChars.includes(char));
const isIntegerNumber = (n) => typeof n === 'bigint' || (!Number.isNaN(Number(n)) && Math.floor(Number(n)) === n);
const isPositiveAndFinite = (n) => typeof n === 'bigint' || (n >= 0 && Number.isSafeInteger(n));

function shuffle(alphabetChars, saltChars) {
  if (saltChars.length === 0) {
    return alphabetChars;
  }
  let integer;
  const transformed = [...alphabetChars];
  for (let i = transformed.length - 1, v = 0, p = 0; i > 0; i--, v++) {
    v %= saltChars.length;
    p += integer = saltChars[v].codePointAt(0);
    const j = (integer + v + p) % i;
    const a = transformed[i];
    const b = transformed[j];
    transformed[j] = a;
    transformed[i] = b;
  }
  return transformed;
}

const toAlphabet = (input, alphabetChars) => {
  const id = [];
  let value = input;
  if (typeof value === 'bigint') {
    const alphabetLength = BigInt(alphabetChars.length);
    do {
      id.unshift(alphabetChars[Number(value % alphabetLength)]);
      value /= alphabetLength;
    } while (value > BigInt(0));
  } else {
    do {
      id.unshift(alphabetChars[value % alphabetChars.length]);
      value = Math.floor(value / alphabetChars.length);
    } while (value > 0);
  }
  return id;
};

const safeParseInt10 = (str) => {
  if (!/^\+?\d+$/.test(str)) {
    return Number.NaN;
  }
  const int10 = Number.parseInt(str, 10);
  if (Number.isSafeInteger(int10)) {
    return int10;
  }
  if (typeof BigInt !== 'function') {
    throw new TypeError('Unable to encode BigInt string without BigInt support');
  }
  return BigInt(str);
};

class Hashids {
  constructor(salt = '', minLength = 0, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', seps = 'cfhistuCFHISTU') {
    this.minLength = minLength;
    if (typeof minLength !== 'number') {
      throw new TypeError(`Hashids: Provided 'minLength' has to be a number (is ${typeof minLength})`);
    }
    if (typeof salt !== 'string') {
      throw new TypeError(`Hashids: Provided 'salt' has to be a string (is ${typeof salt})`);
    }
    if (typeof alphabet !== 'string') {
      throw new TypeError(`Hashids: Provided alphabet has to be a string (is ${typeof alphabet})`);
    }
    const saltChars = Array.from(salt);
    const alphabetChars = Array.from(alphabet);
    const sepsChars = Array.from(seps);
    this.salt = saltChars;
    const uniqueAlphabet = keepUnique(alphabetChars);
    if (uniqueAlphabet.length < 16) {
      throw new Error(`Hashids: alphabet must contain at least 16 unique characters, provided: ${uniqueAlphabet.join('')}`);
    }
    this.alphabet = withoutChars(uniqueAlphabet, sepsChars);
    const filteredSeps = onlyChars(sepsChars, uniqueAlphabet);
    this.seps = shuffle(filteredSeps, saltChars);
    if (this.seps.length === 0 || this.alphabet.length / this.seps.length > 3.5) {
      const sepsLength = Math.ceil(this.alphabet.length / 3.5);
      if (sepsLength > this.seps.length) {
        const diff = sepsLength - this.seps.length;
        this.seps.push(...this.alphabet.slice(0, diff));
        this.alphabet = this.alphabet.slice(diff);
      }
    }
    this.alphabet = shuffle(this.alphabet, saltChars);
    const guardCount = Math.ceil(this.alphabet.length / 12);
    if (this.alphabet.length < 3) {
      this.guards = this.seps.slice(0, guardCount);
      this.seps = this.seps.slice(guardCount);
    } else {
      this.guards = this.alphabet.slice(0, guardCount);
      this.alphabet = this.alphabet.slice(guardCount);
    }
  }

  encode(first, ...inputNumbers) {
    const ret = '';
    let numbers = Array.isArray(first) ? first : [...(first != null ? [first] : []), ...inputNumbers];
    if (numbers.length === 0) {
      return ret;
    }
    if (!numbers.every(isIntegerNumber)) {
      numbers = numbers.map((n) => typeof n === 'bigint' || typeof n === 'number' ? n : safeParseInt10(String(n)));
    }
    if (!numbers.every(isPositiveAndFinite)) {
      return ret;
    }
    return this._encode(numbers).join('');
  }

  _encode(numbers) {
    let { alphabet } = this;
    const numbersIdInt = numbers.reduce((last, number, i) => last + (typeof number === 'bigint' ? Number(number % BigInt(i + 100)) : number % (i + 100)), 0);
    let ret = [alphabet[numbersIdInt % alphabet.length]];
    const lottery = [...ret];
    const { seps } = this;
    const { guards } = this;
    numbers.forEach((number, i) => {
      const buffer = lottery.concat(this.salt, alphabet);
      alphabet = shuffle(alphabet, buffer);
      const last = toAlphabet(number, alphabet);
      ret.push(...last);
      if (i + 1 < numbers.length) {
        const charCode = last[0].codePointAt(0) + i;
        const extraNumber = typeof number === 'bigint' ? Number(number % BigInt(charCode)) : number % charCode;
        ret.push(seps[extraNumber % seps.length]);
      }
    });
    if (ret.length < this.minLength) {
      const prefixGuardIndex = (numbersIdInt + ret[0].codePointAt(0)) % guards.length;
      ret.unshift(guards[prefixGuardIndex]);
      if (ret.length < this.minLength) {
        const suffixGuardIndex = (numbersIdInt + ret[2].codePointAt(0)) % guards.length;
        ret.push(guards[suffixGuardIndex]);
      }
    }
    const halfLength = Math.floor(alphabet.length / 2);
    while (ret.length < this.minLength) {
      alphabet = shuffle(alphabet, alphabet);
      ret.unshift(...alphabet.slice(halfLength));
      ret.push(...alphabet.slice(0, halfLength));
      const excess = ret.length - this.minLength;
      if (excess > 0) {
        const halfOfExcess = excess / 2;
        ret = ret.slice(halfOfExcess, halfOfExcess + this.minLength);
      }
    }
    return ret;
  }
}

const requestTokenHashids = new Hashids('realwebapp', 16);

const getDeviceUUID = () => {
  if (!cachedDeviceUUID) {
    cachedDeviceUUID = crypto.randomUUID();
  }
  return cachedDeviceUUID;
};

const generateRequestToken = () => requestTokenHashids.encode(Date.now());

const buildHeaders = (env) => {
  const authToken = env?.REAL_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('REAL_AUTH_TOKEN is not configured in worker environment.');
  }
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'DNT': '1',
    'Origin': 'https://realsports.io',
    'Referer': REAL_REFERER,
    'User-Agent': DEFAULT_USER_AGENT,
    'sec-ch-ua': DEFAULT_SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'real-auth-info': authToken,
    'real-device-name': DEVICE_NAME,
    'real-device-type': 'desktop_web',
    'real-device-uuid': getDeviceUUID(),
    'real-request-token': generateRequestToken(),
    'real-version': REAL_VERSION
  };
};

const buildCorsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildCorsHeaders() });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Missing userId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...buildCorsHeaders() }
      });
    }

    const apiUrl = `${REAL_API_BASE}/user/${encodeURIComponent(userId)}/karmafeed`;

    try {
      const apiResp = await fetch(apiUrl, {
        headers: buildHeaders(env)
      });

      if (!apiResp.ok) {
        return new Response(JSON.stringify({ error: `API responded with status ${apiResp.status}` }), {
          status: apiResp.status,
          headers: { 'Content-Type': 'application/json', ...buildCorsHeaders() }
        });
      }

      const json = await apiResp.json();

      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...buildCorsHeaders() }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...buildCorsHeaders() }
      });
    }
  }
};
