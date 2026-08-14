/**
 * Local VIN anatomy verification — ZERO API calls.
 *
 * Design doc §5: replaces the paid /vin/{vin} decode call that previously ran
 * once per shortlisted result (5 extra Auto.dev calls per search). VIN structure
 * is an ISO 3779/3780 standard, so year, country, transcription validity, and
 * (often) manufacturer can be verified offline.
 *
 * Deliberately conservative: anything not confidently derivable returns
 * "unknown", never a conflict. A wrong conflict flag is worse than no flag —
 * consistent with the "unknown != false" principle used throughout.
 *
 * The paid /vin/{vin} decode remains available in auto-dev-client for
 * single-vehicle drill-down, where one extra call is justified.
 */

/** Letters excluded from all VINs by standard (avoid confusion with 0/1/5). */
const INVALID_VIN_LETTERS = /[IOQ]/;

/** Position 10 model-year codes. 30-year cycle — disambiguated via position 7. */
const YEAR_CODES: Record<string, [number, number]> = {
  A: [1980, 2010], B: [1981, 2011], C: [1982, 2012], D: [1983, 2013],
  E: [1984, 2014], F: [1985, 2015], G: [1986, 2016], H: [1987, 2017],
  J: [1988, 2018], K: [1989, 2019], L: [1990, 2020], M: [1991, 2021],
  N: [1992, 2022], P: [1993, 2023], R: [1994, 2024], S: [1995, 2025],
  T: [1996, 2026], V: [1997, 2027], W: [1998, 2028], X: [1999, 2029],
  Y: [2000, 2030],
  "1": [2001, 2031], "2": [2002, 2032], "3": [2003, 2033], "4": [2004, 2034],
  "5": [2005, 2035], "6": [2006, 2036], "7": [2007, 2037], "8": [2008, 2038],
  "9": [2009, 2039],
};

/** Check-digit transliteration values (North American VINs). */
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const CHECK_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * WMI prefix -> manufacturer. Standards-assigned (SAE), not a semantic judgment
 * table. Intentionally partial and conservative: an unrecognised prefix yields
 * "unknown" (no conflict), so a missing entry is harmless while a wrong entry
 * would produce a false conflict flag.
 */
const WMI_MAKES: Record<string, string> = {
  // Honda / Acura
  "1HG": "Honda", "2HG": "Honda", "3HG": "Honda", "JHM": "Honda",
  "5FN": "Honda", "5J6": "Honda", "2HK": "Honda", "7FA": "Honda", "7FA R": "Honda",
  "19U": "Acura", "JH4": "Acura", "5J8": "Acura",
  // Toyota / Lexus
  "JTD": "Toyota", "JTE": "Toyota", "JTM": "Toyota", "JTN": "Toyota",
  "4T1": "Toyota", "4T3": "Toyota", "5TD": "Toyota", "5TF": "Toyota",
  "2T1": "Toyota", "2T3": "Toyota", "5TB": "Toyota", "7FA_": "Toyota",
  "JTH": "Lexus", "JTJ": "Lexus", "58A": "Lexus",
  // Ford / Lincoln
  "1FA": "Ford", "1FB": "Ford", "1FC": "Ford", "1FD": "Ford", "1FM": "Ford",
  "1FT": "Ford", "2FA": "Ford", "3FA": "Ford", "1FN": "Ford", "3FM": "Ford",
  "1LN": "Lincoln", "5LM": "Lincoln", "2LM": "Lincoln",
  // GM family
  "1G1": "Chevrolet", "1GC": "Chevrolet", "1GN": "Chevrolet", "2G1": "Chevrolet",
  "3GN": "Chevrolet", "1GB": "Chevrolet", "3GC": "Chevrolet", "KL8": "Chevrolet",
  "1GK": "GMC", "2GK": "GMC", "3GK": "GMC", "1GT": "GMC",
  "1G6": "Cadillac", "1GY": "Cadillac",
  "1G4": "Buick", "5GA": "Buick", "KL4": "Buick",
  // Stellantis
  "1C3": "Chrysler", "2C3": "Chrysler", "3C4": "Chrysler",
  "1C4": "Jeep", "1J4": "Jeep", "1J8": "Jeep",
  "1B3": "Dodge", "2B3": "Dodge", "3D7": "Dodge",
  "3C6": "Ram", "1C6": "Ram",
  // Nissan / Infiniti
  "JN1": "Nissan", "JN8": "Nissan", "1N4": "Nissan", "1N6": "Nissan",
  "5N1": "Nissan", "3N1": "Nissan", "JNK": "Infiniti", "5N3": "Infiniti",
  // Hyundai / Kia
  "KMH": "Hyundai", "KM8": "Hyundai", "5NP": "Hyundai", "5NM": "Hyundai",
  "KNA": "Kia", "KND": "Kia", "5XY": "Kia", "3KP": "Kia", "KNP": "Kia",
  // Subaru / Mazda / Mitsubishi
  "JF1": "Subaru", "JF2": "Subaru", "4S3": "Subaru", "4S4": "Subaru",
  "JM1": "Mazda", "JM3": "Mazda", "4F2": "Mazda", "3MZ": "Mazda",
  "JA4": "Mitsubishi", "ML3": "Mitsubishi", "4A3": "Mitsubishi",
  // VW group
  "WVW": "Volkswagen", "3VW": "Volkswagen", "1VW": "Volkswagen", "WV1": "Volkswagen",
  "WA1": "Audi", "WAU": "Audi", "TRU": "Audi",
  "WP0": "Porsche", "WP1": "Porsche",
  // German premium
  "WBA": "BMW", "WBS": "BMW", "5UX": "BMW", "4US": "BMW", "WBY": "BMW",
  "WDD": "Mercedes-Benz", "WDC": "Mercedes-Benz", "4JG": "Mercedes-Benz",
  "W1K": "Mercedes-Benz", "W1N": "Mercedes-Benz", "WDB": "Mercedes-Benz",
  // Others
  "5YJ": "Tesla", "7SA": "Tesla",
  "YV1": "Volvo", "YV4": "Volvo", "LYV": "Volvo",
  "SAJ": "Jaguar", "SAL": "Land Rover",
};

export interface VinAnatomy {
  formatValid: boolean;
  checkDigitValid: boolean | null; // null = not a North American VIN, rule doesn't apply
  modelYear: number | null;
  manufacturer: string | null; // null = WMI not recognised (unknown, NOT a conflict)
  country: string | null;
}

function isNorthAmerican(vin: string): boolean {
  return /^[1-5]/.test(vin);
}

function countryFromFirstChar(c: string): string | null {
  if (/[1-5]/.test(c)) return c === "2" ? "Canada" : c === "3" ? "Mexico" : "United States";
  if (c === "J") return "Japan";
  if (c === "K") return "South Korea";
  if (c === "L") return "China";
  if (/[S-Z]/.test(c)) return "Europe";
  if (/[6-7]/.test(c)) return "Oceania";
  if (/[8-9]/.test(c)) return "South America";
  return null;
}

function validateCheckDigit(vin: string): boolean | null {
  if (!isNorthAmerican(vin)) return null; // check digit isn't universally enforced outside NA
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (value === undefined) return null; // unexpected character — inconclusive, not a failure
    sum += value * CHECK_WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? "X" : String(remainder);
  return vin[8] === expected;
}

function modelYearFrom(vin: string): number | null {
  const code = vin[9];
  const pair = YEAR_CODES[code];
  if (!pair) return null;
  // Standard disambiguation: position 7 numeric => 1980-2009 cycle,
  // alphabetic => 2010+ cycle.
  const pos7 = vin[6];
  const isNewerCycle = /[A-Z]/.test(pos7);
  const year = isNewerCycle ? pair[1] : pair[0];
  // Guard against implausible future years from malformed data.
  const currentYear = new Date().getFullYear();
  if (year > currentYear + 2) return pair[0];
  return year;
}

export function analyzeVin(rawVin: string | undefined): VinAnatomy {
  const vin = (rawVin ?? "").trim().toUpperCase();
  const formatValid = vin.length === 17 && !INVALID_VIN_LETTERS.test(vin) && /^[A-Z0-9]+$/.test(vin);

  if (!formatValid) {
    return { formatValid: false, checkDigitValid: null, modelYear: null, manufacturer: null, country: null };
  }

  return {
    formatValid: true,
    checkDigitValid: validateCheckDigit(vin),
    modelYear: modelYearFrom(vin),
    manufacturer: WMI_MAKES[vin.slice(0, 3)] ?? null,
    country: countryFromFirstChar(vin[0]),
  };
}
