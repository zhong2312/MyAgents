const sensitiveAssignment =
  /((?:["']?)(?:(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|token|auth(?:orization)?|bearer|password|passwd|secret|credential|cookie|webhook)(?:[-_][A-Za-z0-9]+)*(?:["']?))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const camelSensitiveAssignment =
  /(\b[A-Za-z0-9]*(?:apiKey|accessKey(?:Id)?|secretAccessKey|secretKey|privateKey|accessToken|refreshToken|idToken|sessionToken|authToken|clientSecret|password|passwd|credential|webhookUrl)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const sensitiveHeader = /\b(?:proxy[-_])?authorization\s*[:=]\s*.*$/gi;
const authHeader = /\b(?:Bearer|Basic|ApiKey|Digest)\s+[^\s,;"']+/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const knownToken =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g;
const longEncodedValue = /[A-Za-z0-9+/_-]{48,}={0,2}/g;
const databaseUri =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):(?:\\?\/){2}[^\s<>"']+/gi;
const credentialUri =
  /\b[A-Za-z][A-Za-z0-9+.-]*:(?:\\?\/){2}[^\s<>"']*:[^\s<>"'@]+@[^\s<>"']+/gi;
const url = /\b(?:https?|wss?):(?:\\?\/){2}[^\s<>"']+/gi;
const unixHome = /\/(?:Users|home)\/[^/\s]+/g;
const windowsHome = /[A-Za-z]:\\Users\\[^\\\s]+/gi;
const sensitiveLabelOnly =
  /^\s*["']?(?:api[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|token|authorization|password|secret|credential)["']?\s*[:=]\s*$/i;

export function createLogRedactor() {
  let redactNextLine = false;
  let insidePrivateKey = false;

  return function redact(line) {
    if (redactNextLine) {
      redactNextLine = false;
      return '<redacted-sensitive-value>';
    }
    if (/-----BEGIN .*PRIVATE KEY-----/i.test(line)) {
      insidePrivateKey = true;
      return '<redacted-private-key>';
    }
    if (/-----END .*PRIVATE KEY-----/i.test(line)) {
      insidePrivateKey = false;
      return '<redacted-private-key>';
    }
    if (insidePrivateKey) {
      if (/^\s*[A-Za-z0-9+/=]{8,}\s*$/.test(line)) {
        return '<redacted-private-key-data>';
      }
      // `rg` output may contain BEGIN without END. Stop carrying state as soon
      // as the next selected line no longer looks like private-key payload.
      insidePrivateKey = false;
    }
    if (sensitiveLabelOnly.test(line)) {
      redactNextLine = true;
      return `${line.replace(/[:=\s]+$/, '')}: <redacted-next-line>`;
    }

    return line
      .replace(databaseUri, '<redacted-database-uri>')
      .replace(credentialUri, '<redacted-credential-uri>')
      .replace(url, '<redacted-url>')
      .replace(sensitiveHeader, 'Authorization: <redacted>')
      .replace(authHeader, '<redacted-auth>')
      .replace(camelSensitiveAssignment, '$1<redacted>')
      .replace(sensitiveAssignment, '$1<redacted>')
      .replace(jwt, '<redacted-jwt>')
      .replace(knownToken, '<redacted-token>')
      .replace(longEncodedValue, '<redacted-encoded-value>')
      .replace(unixHome, '<HOME>')
      .replace(windowsHome, '<HOME>');
  };
}
