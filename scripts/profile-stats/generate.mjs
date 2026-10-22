import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// No dependencies, remote code, mutations, or configurable API destinations.
const ENDPOINT = 'https://api.github.com/graphql';
const OUTPUT = 'profile-3d-contrib';
const PROFILE_QUERY = `query Profile($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      commitContributionsByRepository(maxRepositories: 100) {
        repository { primaryLanguage { name color } }
        contributions { totalCount }
      }
    }
  }
}`;
const REPOS_QUERY = `query Repositories($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER) {
      nodes { stargazerCount forkCount }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export async function queryGitHub(token, query, variables, fetcher = fetch, inspectHeaders = () => {}) {
  if (!token) throw new Error('PROFILE_STATS_TOKEN is missing.');
  const response = await fetcher(ENDPOINT, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'User-Agent': 'rahoney-profile-stats',
    },
    body: JSON.stringify({ query, variables }),
  });
  // Do not print response bodies: GraphQL errors can contain private details.
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
  inspectHeaders(response.headers);
  const result = await response.json();
  if (result.errors?.length || !result.data?.user) {
    throw new Error('GitHub statistics query failed. Check token permissions and username.');
  }
  return result.data.user;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid contribution count.');
  return value;
}

export function aggregate(collection, username) {
  const calendar = collection.contributionCalendar;
  const days = calendar.weeks.flatMap(week => week.contributionDays).map(day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date))) {
      throw new Error('Invalid contribution date.');
    }
    return { date: day.date, count: count(day.contributionCount), level: day.contributionLevel };
  });
  if (!days.length) throw new Error('GitHub returned an empty calendar.');
  const commits = count(collection.totalCommitContributions);
  const byLanguage = new Map();
  for (const item of collection.commitContributionsByRepository) {
    const language = item.repository?.primaryLanguage;
    if (!language?.name) continue;
    const previous = byLanguage.get(language.name);
    byLanguage.set(language.name, {
      name: language.name,
      color: /^#[\da-f]{6}$/i.test(language.color || '') ? language.color : '#64748b',
      count: (previous?.count || 0) + count(item.contributions.totalCount),
    });
  }
  const languages = [...byLanguage.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const classified = languages.reduce((sum, language) => sum + language.count, 0);
  if (classified > commits) throw new Error('Language contribution counts exceed total commits.');
  // Only aggregate values leave this function. No private repository names are published.
  return {
    username, total: count(calendar.totalContributions), commits,
    issues: count(collection.totalIssueContributions),
    pullRequests: count(collection.totalPullRequestContributions),
    reviews: count(collection.totalPullRequestReviewContributions),
    repositories: count(collection.totalRepositoryContributions),
    stars: 0, forks: 0, days, languages, unclassified: commits - classified,
  };
}

export async function collectStats(token, username, fetcher = fetch) {
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(username || '')) throw new Error('Invalid GitHub username.');
  let repositoryScope = null;
  const user = await queryGitHub(token, PROFILE_QUERY, { login: username }, fetcher, headers => {
    const scopes = headers?.get('x-oauth-scopes');
    if (scopes !== undefined && scopes !== null) {
      repositoryScope = scopes.split(',').map(scope => scope.trim()).includes('repo');
    }
  });
  const stats = aggregate(user.contributionsCollection, username);
  stats.repositoryScope = repositoryScope;
  let after = null;
  const cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const { repositories } = await queryGitHub(token, REPOS_QUERY, { login: username, after }, fetcher);
    for (const repo of repositories.nodes) {
      stats.stars += count(repo.stargazerCount);
      stats.forks += count(repo.forkCount);
    }
    if (!repositories.pageInfo.hasNextPage) return stats;
    after = repositories.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error('Invalid GitHub pagination cursor.');
    cursors.add(after);
  }
  throw new Error('Repository pagination exceeded the safety limit.');
}

export const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const n = value => Number(value.toFixed(2));
const number = value => value.toLocaleString('en-US');
const text = (x, y, value, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${escapeXml(value)}</text>`;
const polygon = (points, attrs) => `<polygon points="${points.map(point => point.map(n).join(',')).join(' ')}" ${attrs}/>`;

function calendarSvg(stats, animated) {
  const first = Date.parse(stats.days[0].date);
  const firstWeekday = new Date(first).getUTCDay();
  const origin = first - firstWeekday * 86400000;
  // Match the original 30-degree isometric view: show more of each day's top face.
  const horizontalStep = 19;
  const verticalStep = horizontalStep * Math.tan(Math.PI / 6);
  const tileHalfWidth = 17;
  const tileHalfHeight = tileHalfWidth * Math.tan(Math.PI / 6);
  const colors = {
    NONE: ['#eff3ec', '#d4dfd0', '#b9cab5'],
    FIRST_QUARTILE: ['#c5e6a4', '#9fc778', '#81aa5c'],
    SECOND_QUARTILE: ['#86c86d', '#61a74e', '#48873c'],
    THIRD_QUARTILE: ['#48a249', '#318638', '#23682c'],
    FOURTH_QUARTILE: ['#24733b', '#175b2c', '#104622'],
  };
  return stats.days.map(day => {
    const date = new Date(day.date);
    const week = Math.floor((date.getTime() - origin) / 604800000);
    const weekday = date.getUTCDay();
    const x = 145 + (week - weekday) * horizontalStep;
    const y = 138 + (week + weekday) * verticalStep;
    const h = 3 + Math.log10(1 + day.count / 20) * 115;
    const [top, left, right] = colors[day.level] || colors.NONE;
    const topY = y - h;
    return `<g class="${animated ? 'bar' : ''}"><title>${escapeXml(day.date)}: ${day.count} contributions</title>` +
      polygon([[x, topY], [x + tileHalfWidth, topY - tileHalfHeight], [x + 2 * tileHalfWidth, topY], [x + tileHalfWidth, topY + tileHalfHeight]], `fill="${top}"`) +
      polygon([[x, topY], [x + tileHalfWidth, topY + tileHalfHeight], [x + tileHalfWidth, y + tileHalfHeight], [x, y]], `fill="${left}"`) +
      polygon([[x + tileHalfWidth, topY + tileHalfHeight], [x + 2 * tileHalfWidth, topY], [x + 2 * tileHalfWidth, y], [x + tileHalfWidth, y + tileHalfHeight]], `fill="${right}"`) + '</g>';
  }).join('');
}

function radarSvg(stats) {
  const values = [stats.commits, stats.issues, stats.pullRequests, stats.reviews, stats.repositories];
  const labels = ['Commit', 'Issue', 'Pull request', 'Review', 'Repository'];
  const center = [1015, 224];
  const radius = 125;
  const at = (index, fraction) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
    return [center[0] + Math.cos(angle) * radius * fraction, center[1] + Math.sin(angle) * radius * fraction];
  };
  const maximum = Math.max(10, ...values);
  let result = '';
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    result += polygon(values.map((_, i) => at(i, fraction)), 'fill="none" stroke="#d9e4d6" stroke-width="1"');
  }
  values.forEach((value, i) => {
    const [x, y] = at(i, 1.3);
    const endpoint = at(i, 1);
    result += `<path d="M${center.join(',')} L${endpoint.map(n).join(',')}" stroke="#d9e4d6"/>`;
    result += text(n(x), n(y), labels[i], 'text-anchor="middle" font-size="16"');
    result += text(n(x), n(y + 22), number(value), 'text-anchor="middle" font-size="16" font-weight="700"');
  });
  result += polygon(values.map((value, i) => at(i, Math.log10(value + 1) / Math.log10(maximum + 1))),
    'fill="#48a249" fill-opacity="0.28" stroke="#318638" stroke-width="2"');
  return result;
}

export function languageSlices(stats) {
  const slices = stats.languages.slice(0, 5).map(language => ({ ...language }));
  const other = stats.languages.slice(5).reduce((sum, language) => sum + language.count, 0);
  if (other) slices.push({ name: 'Other languages', color: '#899b8b', count: other });
  if (stats.unclassified) slices.push({ name: 'Unclassified', color: '#cbd5e1', count: stats.unclassified });
  return slices;
}

function pieSvg(stats) {
  const slices = languageSlices(stats);
  let angle = -Math.PI / 2;
  let result = text(65, 552, 'COMMITS BY REPOSITORY LANGUAGE', 'font-size="14" letter-spacing="1" fill="#5f7261"');
  if (!stats.commits) return result + text(75, 650, 'No commits in this period', 'font-size="18"');
  slices.forEach((slice, i) => {
    const fraction = slice.count / stats.commits;
    const end = angle + fraction * Math.PI * 2;
    const [cx, cy, r] = [180, 673, 96];
    const point = a => [n(cx + Math.cos(a) * r), n(cy + Math.sin(a) * r)].join(',');
    if (fraction >= 0.999999) result += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${slice.color}"><title>${escapeXml(slice.name)}: ${slice.count}</title></circle>`;
    else result += `<path d="M${cx},${cy} L${point(angle)} A${r},${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${point(end)} Z" fill="${slice.color}" stroke="white" stroke-width="2"><title>${escapeXml(slice.name)}: ${slice.count}</title></path>`;
    angle = end;
    const y = 588 + i * 27;
    result += `<rect x="310" y="${y - 13}" width="14" height="14" rx="3" fill="${slice.color}"/>`;
    result += text(335, y, slice.name, 'font-size="17"');
    result += text(620, y, `${number(slice.count)} · ${(fraction * 100).toFixed(1)}%`, 'font-size="15" text-anchor="end" fill="#5f7261"');
  });
  result += '<circle cx="180" cy="673" r="57" fill="white"/>';
  result += text(180, 670, number(stats.commits), 'font-size="25" text-anchor="middle" font-weight="700"');
  result += text(180, 692, 'commits', 'font-size="14" text-anchor="middle" fill="#5f7261"');
  return result;
}

export function renderSvg(stats, animated = true) {
  const from = stats.days[0].date;
  const to = stats.days.at(-1).date;
  const description = `${stats.username}: ${stats.total} contributions, ${stats.commits} commits, ${from} to ${to}. Language counts use repository primary language; ${stats.unclassified} commits have unavailable language data.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="850" viewBox="0 0 1280 850" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(stats.username)} · GitHub contributions</title>
<desc id="description">${escapeXml(description)}</desc>
<style>text{font-family:system-ui,-apple-system,Segoe UI,sans-serif;fill:#203d29}.bar{animation:appear 1.2s ease-out both}@keyframes appear{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.bar{animation:none}}</style>
<rect width="1280" height="850" fill="white"/>
${text(40, 43, `${stats.username} / contributions`, 'font-size="24" font-weight="600"')}
${text(1240, 39, `${from} / ${to}`, 'font-size="14" text-anchor="end" fill="#5f7261"')}
${calendarSvg(stats, animated)}${radarSvg(stats)}${pieSvg(stats)}
${text(640, 814, `${number(stats.total)} contributions`, 'font-size="30" text-anchor="middle" font-weight="700"')}
${text(1240, 814, `Stars ${number(stats.stars)} · Forks ${number(stats.forks)}`, 'font-size="17" text-anchor="end"')}
</svg>\n`;
}

export async function main() {
  const username = process.env.USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
  const stats = await collectStats(process.env.PROFILE_STATS_TOKEN, username);
  const animated = renderSvg(stats, true);
  const still = renderSvg(stats, false);
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(`${OUTPUT}/profile-green-animate.svg`, animated, 'utf8');
  await writeFile(`${OUTPUT}/profile-green.svg`, still, 'utf8');
  console.log(`Generated profile: ${stats.total} contributions, ${stats.commits} commits; ${stats.unclassified} unclassified language contributions.`);
  const access = stats.repositoryScope === null ? 'not reported' : stats.repositoryScope ? 'present' : 'absent';
  console.log(`Classic token repo scope: ${access}; ${stats.languages.length} languages classified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Never log an exception with authorization headers or private API response data.
    console.error('Profile generation failed. Check GitHub availability, token permissions, and configuration.');
    process.exitCode = 1;
  });
}
