// meridian — stubbed parser tests for collectors 37 (HK CR) and 38
// (Enhetsregisteret). Pure parse functions only; no network.
import { test, expect } from "bun:test";
import {
  parseHkCompany, kommunenummerFor, parseBrregEnhet, domainLabel,
} from "./sources";

// ---------- 37. HK Companies Registry ----------

const HK_ROW = {
  Brn: "C1537852",
  Chinese_Company_Name: "香港鐘華萱紡織實業集團有限公司",
  English_Company_Name: "HONGKONG ZHONGHUAXUAN TEXTILE INDUSTRY GROUP LIMITED",
  Address_of_Registered_Office:
    "ROOM 701, UNIT 108, 7/F, TOWER B, NEW MANDARIN PLAZA, 14 SCIENCE MUSEUM ROAD, TSIM SHA TSUI, KOWLOON, HONG KONG",
  Company_Type: "Private company limited by shares",
  Date_of_Incorporation: "08-12-2010",
  "Re-domiciliation_Date": null,
};

test("parseHkCompany extracts brn, name, detail", () => {
  const p = parseHkCompany(HK_ROW);
  expect(p).not.toBeNull();
  expect(p!.brn).toBe("C1537852");
  expect(p!.name).toContain("ZHONGHUAXUAN");
  expect(p!.detail).toContain("BRN C1537852");
  expect(p!.detail).toContain("Private company limited by shares");
  expect(p!.detail).toContain("TSIM SHA TSUI");
  expect(p!.detail).toContain("inc. 08-12-2010");
});

test("parseHkCompany falls back to Chinese name", () => {
  const p = parseHkCompany({ Brn: "C1", Chinese_Company_Name: "測試有限公司" });
  expect(p).not.toBeNull();
  expect(p!.name).toBe("測試有限公司");
});

test("parseHkCompany rejects junk", () => {
  expect(parseHkCompany(null)).toBeNull();
  expect(parseHkCompany({})).toBeNull();
  expect(parseHkCompany({ Brn: "!!!", English_Company_Name: "X" })).toBeNull();
  expect(parseHkCompany({ Brn: "C1" })).toBeNull(); // no name at all
});

// ---------- 38. Enhetsregisteret ----------

test("kommunenummerFor maps major kommuner", () => {
  expect(kommunenummerFor("Oslo")).toBe("0301");
  expect(kommunenummerFor("Bergen")).toBe("4601");
  expect(kommunenummerFor("Tromsø")).toBe("5401"); // diacritics normalize
  expect(kommunenummerFor("TRONDHEIM")).toBe("5001");
  expect(kommunenummerFor("Sandvika")).toBe("3024");
});

test("kommunenummerFor returns null outside the table", () => {
  expect(kommunenummerFor("Paris")).toBeNull();
  expect(kommunenummerFor("")).toBeNull();
  expect(kommunenummerFor("Lillehammer")).toBeNull(); // real kommune, not in table
});

const BRREG_ROW = {
  organisasjonsnummer: "934551435",
  navn: "ADVOKATFIRMAET CATO MYHRE",
  organisasjonsform: { kode: "ENK", beskrivelse: "Enkeltpersonforetak" },
  registreringsdatoEnhetsregisteret: "2024-11-27",
  naeringskode1: { kode: "69.100", beskrivelse: "Juridisk tjenesteyting" },
  forretningsadresse: {
    land: "Norge", landkode: "NO", postnummer: "0374", poststed: "OSLO",
    adresse: ["Grimelundshaugen 33"], kommune: "OSLO", kommunenummer: "0301",
  },
  aktivitet: ["Advokat."],
  konkurs: false,
  underAvvikling: false,
};

test("parseBrregEnhet extracts orgnr, name, detail, url", () => {
  const p = parseBrregEnhet(BRREG_ROW);
  expect(p).not.toBeNull();
  expect(p!.orgnr).toBe("934551435");
  expect(p!.name).toBe("ADVOKATFIRMAET CATO MYHRE");
  expect(p!.detail).toContain("org.nr 934 551 435");
  expect(p!.detail).toContain("Enkeltpersonforetak");
  expect(p!.detail).toContain("Grimelundshaugen 33");
  expect(p!.detail).toContain("0374 OSLO");
  expect(p!.detail).toContain("Advokat.");
  expect(p!.url).toBe("https://data.brreg.no/enhetsregisteret/api/enheter/934551435");
});

test("parseBrregEnhet flags konkurs / under avvikling", () => {
  const p = parseBrregEnhet({ ...BRREG_ROW, konkurs: true, underAvvikling: true });
  expect(p!.detail).toContain("konkurs");
  expect(p!.detail).toContain("under avvikling");
});

test("parseBrregEnhet tolerates missing address/activity", () => {
  const p = parseBrregEnhet({ organisasjonsnummer: "123456789", navn: "TEST AS" });
  expect(p).not.toBeNull();
  expect(p!.detail).toContain("org.nr 123 456 789");
});

test("parseBrregEnhet strips leading dash runs from names", () => {
  const p = parseBrregEnhet({ ...BRREG_ROW, navn: "----ADVOKATFIRMAET CATO MYHRE" });
  expect(p!.name).toBe("ADVOKATFIRMAET CATO MYHRE");
});

test("parseBrregEnhet rejects junk", () => {
  expect(parseBrregEnhet(null)).toBeNull();
  expect(parseBrregEnhet({})).toBeNull();
  expect(parseBrregEnhet({ organisasjonsnummer: "123", navn: "X" })).toBeNull();
  expect(parseBrregEnhet({ organisasjonsnummer: "934551435" })).toBeNull();
});

// ---------- shared keyword helper ----------

test("domainLabel handles ccTLD second-level suffixes", () => {
  expect(domainLabel("hsbc.com.hk")).toBe("hsbc");
  expect(domainLabel("example.co.uk")).toBe("example");
  expect(domainLabel("acme.com")).toBe("acme");
  expect(domainLabel("foo.blogspot.com")).toBe("blogspot");
  expect(domainLabel("")).toBe("");
});
