/**
 * Check if the user has the required claims
 * @param {Object} claims - The user's claims
 * @param {Object} requiredClaims - The claims required for an action or discount
 * @returns {boolean} - Returns true if all required claims are met, false otherwise
 */
export function checkClaims(claims, requiredClaims) {
  if (!requiredClaims) {
    return true;
  }
  if (!claims) {
    return false;
  }
  for (const key in requiredClaims) {
    const parts = key.split(".");
    let obj = claims;
    for (let i=0; i < parts.length; i++) {
      const part = parts[i];
      let newObj = obj[part];
      if (!newObj) {
        return false;
      }
      if (i === parts.length - 1) {
        return newObj === requiredClaims[key];
      }
      obj = newObj;
    }
  }
  return false;
}
