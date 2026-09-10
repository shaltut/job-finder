// The country list behind the two scope pickers in Settings.
//
// Deliberately a bundled constant, not a LinkedIn fetch. Country names never reach a LinkedIn URL —
// they appear only as prose inside two prompts (systemPrompt here in the scraper, profileBlock in the
// drafter). LinkedIn publishes no country-list endpoint, and reading its taxonomy would need the
// logged-in session plus extra requests against the same account the scraper rate-limits.
//
// `name` is both the display label and the stored value, so it prefers the short form a job post
// actually uses ('UAE', not 'United Arab Emirates'). The long forms live in `aliases`, which is what
// lets the scoring model match post text and what resolves legacy config values on import.

/** [alpha-2, display name, ...aliases] — compact so the table stays readable. */
const RAW: readonly (readonly string[])[] = [
  ['AF', 'Afghanistan'], ['AL', 'Albania'], ['DZ', 'Algeria'], ['AD', 'Andorra'], ['AO', 'Angola'],
  ['AG', 'Antigua and Barbuda'], ['AR', 'Argentina'], ['AM', 'Armenia'], ['AU', 'Australia'],
  ['AT', 'Austria'], ['AZ', 'Azerbaijan'], ['BS', 'Bahamas'], ['BH', 'Bahrain'], ['BD', 'Bangladesh'],
  ['BB', 'Barbados'], ['BY', 'Belarus'], ['BE', 'Belgium'], ['BZ', 'Belize'], ['BJ', 'Benin'],
  ['BT', 'Bhutan'], ['BO', 'Bolivia'], ['BA', 'Bosnia and Herzegovina', 'Bosnia'], ['BW', 'Botswana'],
  ['BR', 'Brazil'], ['BN', 'Brunei'], ['BG', 'Bulgaria'], ['BF', 'Burkina Faso'], ['BI', 'Burundi'],
  ['KH', 'Cambodia'], ['CM', 'Cameroon'], ['CA', 'Canada'], ['CV', 'Cape Verde', 'Cabo Verde'],
  ['CF', 'Central African Republic'], ['TD', 'Chad'], ['CL', 'Chile'], ['CN', 'China'],
  ['CO', 'Colombia'], ['KM', 'Comoros'], ['CG', 'Congo', 'Republic of the Congo'],
  ['CD', 'DR Congo', 'Democratic Republic of the Congo', 'Congo-Kinshasa'], ['CR', 'Costa Rica'],
  ['CI', 'Ivory Coast', 'Cote d\'Ivoire', 'Côte d\'Ivoire'], ['HR', 'Croatia'], ['CU', 'Cuba'],
  ['CY', 'Cyprus'], ['CZ', 'Czechia', 'Czech Republic'], ['DK', 'Denmark'], ['DJ', 'Djibouti'],
  ['DM', 'Dominica'], ['DO', 'Dominican Republic'], ['EC', 'Ecuador'],
  ['EG', 'Egypt', 'Arab Republic of Egypt'], ['SV', 'El Salvador'], ['GQ', 'Equatorial Guinea'],
  ['ER', 'Eritrea'], ['EE', 'Estonia'], ['SZ', 'Eswatini', 'Swaziland'], ['ET', 'Ethiopia'],
  ['FJ', 'Fiji'], ['FI', 'Finland'], ['FR', 'France'], ['GA', 'Gabon'], ['GM', 'Gambia'],
  ['GE', 'Georgia'], ['DE', 'Germany', 'Deutschland'], ['GH', 'Ghana'], ['GR', 'Greece'],
  ['GD', 'Grenada'], ['GT', 'Guatemala'], ['GN', 'Guinea'], ['GW', 'Guinea-Bissau'], ['GY', 'Guyana'],
  ['HT', 'Haiti'], ['HN', 'Honduras'], ['HK', 'Hong Kong', 'Hong Kong SAR'], ['HU', 'Hungary'],
  ['IS', 'Iceland'], ['IN', 'India'], ['ID', 'Indonesia'], ['IR', 'Iran'], ['IQ', 'Iraq'],
  ['IE', 'Ireland', 'Republic of Ireland'], ['IL', 'Israel'], ['IT', 'Italy'], ['JM', 'Jamaica'],
  ['JP', 'Japan'], ['JO', 'Jordan'], ['KZ', 'Kazakhstan'], ['KE', 'Kenya'], ['KI', 'Kiribati'],
  ['KW', 'Kuwait'], ['KG', 'Kyrgyzstan'], ['LA', 'Laos'], ['LV', 'Latvia'], ['LB', 'Lebanon'],
  ['LS', 'Lesotho'], ['LR', 'Liberia'], ['LY', 'Libya'], ['LI', 'Liechtenstein'], ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'], ['MG', 'Madagascar'], ['MW', 'Malawi'], ['MY', 'Malaysia'], ['MV', 'Maldives'],
  ['ML', 'Mali'], ['MT', 'Malta'], ['MH', 'Marshall Islands'], ['MR', 'Mauritania'],
  ['MU', 'Mauritius'], ['MX', 'Mexico'], ['FM', 'Micronesia'], ['MD', 'Moldova'], ['MC', 'Monaco'],
  ['MN', 'Mongolia'], ['ME', 'Montenegro'], ['MA', 'Morocco'], ['MZ', 'Mozambique'],
  ['MM', 'Myanmar', 'Burma'], ['NA', 'Namibia'], ['NR', 'Nauru'], ['NP', 'Nepal'],
  ['NL', 'Netherlands', 'Holland', 'The Netherlands'], ['NZ', 'New Zealand'], ['NI', 'Nicaragua'],
  ['NE', 'Niger'], ['NG', 'Nigeria'], ['KP', 'North Korea'],
  ['MK', 'North Macedonia', 'Macedonia'], ['NO', 'Norway'], ['OM', 'Oman'], ['PK', 'Pakistan'],
  ['PW', 'Palau'], ['PS', 'Palestine', 'Palestinian Territories'], ['PA', 'Panama'],
  ['PG', 'Papua New Guinea'], ['PY', 'Paraguay'], ['PE', 'Peru'], ['PH', 'Philippines'],
  ['PL', 'Poland'], ['PT', 'Portugal'], ['PR', 'Puerto Rico'],
  ['QA', 'Qatar', 'State of Qatar'], ['RO', 'Romania'], ['RU', 'Russia', 'Russian Federation'],
  ['RW', 'Rwanda'], ['KN', 'Saint Kitts and Nevis'], ['LC', 'Saint Lucia'],
  ['VC', 'Saint Vincent and the Grenadines'], ['WS', 'Samoa'], ['SM', 'San Marino'],
  ['ST', 'Sao Tome and Principe'],
  ['SA', 'Saudi Arabia', 'KSA', 'Kingdom of Saudi Arabia'], ['SN', 'Senegal'], ['RS', 'Serbia'],
  ['SC', 'Seychelles'], ['SL', 'Sierra Leone'], ['SG', 'Singapore'], ['SK', 'Slovakia'],
  ['SI', 'Slovenia'], ['SB', 'Solomon Islands'], ['SO', 'Somalia'], ['ZA', 'South Africa'],
  ['KR', 'South Korea', 'Korea', 'Republic of Korea'], ['SS', 'South Sudan'], ['ES', 'Spain'],
  ['LK', 'Sri Lanka'], ['SD', 'Sudan'], ['SR', 'Suriname'], ['SE', 'Sweden'], ['CH', 'Switzerland'],
  ['SY', 'Syria'], ['TW', 'Taiwan'], ['TJ', 'Tajikistan'], ['TZ', 'Tanzania'], ['TH', 'Thailand'],
  ['TL', 'Timor-Leste', 'East Timor'], ['TG', 'Togo'], ['TO', 'Tonga'],
  ['TT', 'Trinidad and Tobago'], ['TN', 'Tunisia'], ['TR', 'Turkey', 'Türkiye', 'Turkiye'],
  ['TM', 'Turkmenistan'], ['TV', 'Tuvalu'], ['UG', 'Uganda'], ['UA', 'Ukraine'],
  ['AE', 'UAE', 'United Arab Emirates', 'Emirates', 'U.A.E.'],
  ['GB', 'UK', 'United Kingdom', 'Great Britain', 'Britain', 'England'],
  ['US', 'USA', 'United States', 'United States of America', 'US', 'U.S.'],
  ['UY', 'Uruguay'], ['UZ', 'Uzbekistan'], ['VU', 'Vanuatu'], ['VA', 'Vatican City', 'Holy See'],
  ['VE', 'Venezuela'], ['VN', 'Vietnam', 'Viet Nam'], ['YE', 'Yemen'], ['ZM', 'Zambia'],
  ['ZW', 'Zimbabwe']
]

/** ccTLDs that are not simply the lower-cased alpha-2 code. */
const TLD_OVERRIDES: Record<string, string> = { GB: 'uk' }

export interface Country {
  /** ISO 3166-1 alpha-2. */
  code: string
  /** Display label and the value stored in settings. */
  name: string
  aliases: string[]
}

export const COUNTRIES: Country[] = RAW.map(([code, name, ...aliases]) => ({
  code: code!,
  name: name!,
  aliases: aliases as string[]
}))

/** Lower-cased name and alias -> country, built once. */
const BY_LABEL = new Map<string, Country>()
for (const c of COUNTRIES) {
  BY_LABEL.set(c.name.toLowerCase(), c)
  for (const a of c.aliases) BY_LABEL.set(a.toLowerCase(), c)
}

/**
 * Resolve a stored or typed string to a country. Matches the display name or any alias,
 * case- and whitespace-insensitively, so a legacy config saying 'United Arab Emirates'
 * lands on the same entry the picker offers as 'UAE'.
 */
export function resolveCountry(input: string): Country | undefined {
  return BY_LABEL.get(input.trim().toLowerCase())
}

/**
 * Aliases collapsed to their display form, so 'United Arab Emirates' and 'UAE' stop being two
 * entries. A name the table does not know is KEPT, not dropped: this runs on every write, and
 * silently deleting a country the user stored would be a data loss they never asked for.
 */
export function normalizeCountries(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const label = resolveCountry(n)?.name ?? n.trim()
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

/**
 * ccTLDs for the given countries, for the scoring prompt's "the contact email domain points to..."
 * hint. Replaces a hardcoded '.eg .sa .ae .qa' that was wrong for any other scope.
 */
export function tldsFor(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const c = resolveCountry(n)
    if (!c) continue
    const tld = '.' + (TLD_OVERRIDES[c.code] ?? c.code.toLowerCase())
    if (!out.includes(tld)) out.push(tld)
  }
  return out
}

/** 'UAE (United Arab Emirates, Emirates)' — aliases inline so the scoring model matches post text. */
export function withAliases(names: string[]): string {
  return names.map((n) => {
    const c = resolveCountry(n)
    if (!c || !c.aliases.length) return n
    return `${c.name} (${c.aliases.join(', ')})`
  }).join(', ')
}
