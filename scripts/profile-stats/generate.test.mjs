import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, collectStats, escapeXml, languageSlices, queryGitHub, renderSvg } from './generate.mjs';

function collection() {
  return {
    contributionCalendar: {
      totalContributions: 15,
      weeks: [{ contributionDays: [
        { date: '2026-10-21', contributionCount: 15, contributionLevel: 'FOURTH_QUARTILE' },
      ] }],
    },
    totalCommitContributions: 12, totalIssueContributions: 0,
    totalPullRequestContributions: 2, totalPullRequestReviewContributions: 1,
    totalRepositoryContributions: 0,
    commitContributionsByRepository: [
      { repository: { nameWithOwner: 'private/never-publish', primaryLanguage: { name: 'Python', color: '#3572A5' } }, contributions: { totalCount: 7 } },
      { repository: { primaryLanguage: { name: 'Python', color: '#3572A5' } }, contributions: { totalCount: 2 } },
      { repository: { primaryLanguage: { name: 'Go', color: '#00ADD8' } }, contributions: { totalCount: 1 } },
      { repository: { primaryLanguage: null }, contributions: { totalCount: 2 } },
    ],
  };
}

test('keeps official totals, merges languages, and explicitly accounts for unavailable metadata', () => {
  const stats = aggregate(collection(), 'rahoney');
  assert.equal(stats.total, 15);
  assert.equal(stats.commits, 12);
  assert.equal(stats.languages[0].name, 'Python');
  assert.equal(stats.languages[0].count, 9);
  assert.equal(stats.unclassified, 2);
  assert.equal(languageSlices(stats).reduce((sum, slice) => sum + slice.count, 0), 12);
  const svg = renderSvg(stats);
  assert.match(svg, /Unclassified/);
  assert.match(svg, /Python: 9/);
  assert.doesNotMatch(svg, /private\/never-publish/);
});

test('separates known small languages from inaccessible languages', () => {
  const stats = aggregate(collection(), 'rahoney');
  stats.languages = Array.from({ length: 7 }, (_, i) => ({ name: `Language${i}`, color: '#123456', count: 1 }));
  stats.commits = 10;
  stats.unclassified = 3;
  const slices = languageSlices(stats);
  assert.equal(slices.find(slice => slice.name === 'Other languages').count, 2);
  assert.equal(slices.find(slice => slice.name === 'Unclassified').count, 3);
});

test('escapes language labels and rejects colors capable of injecting SVG', () => {
  const input = collection();
  input.commitContributionsByRepository[0].repository.primaryLanguage = { name: '<script>&"', color: 'red" onload="bad' };
  const svg = renderSvg(aggregate(input, 'rahoney'));
  assert.match(svg, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(svg, /<script|onload=/);
  assert.equal(escapeXml("a'b"), 'a&apos;b');
});

test('handles zero commits without invalid pie coordinates', () => {
  const input = collection();
  input.totalCommitContributions = 0;
  input.commitContributionsByRepository = [];
  const svg = renderSvg(aggregate(input, 'rahoney'), false);
  assert.match(svg, /No commits in this period/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('fails on corrupt data rather than publishing plausible incorrect totals', () => {
  const input = collection();
  input.totalCommitContributions = 1;
  assert.throws(() => aggregate(input, 'rahoney'), /exceed/);
  input.totalCommitContributions = -1;
  assert.throws(() => aggregate(input, 'rahoney'), /Invalid contribution/);
});

test('uses only fixed GitHub queries and paginates repository counts', async () => {
  const requests = [];
  const responses = [
    { contributionsCollection: collection() },
    { repositories: { nodes: [{ stargazerCount: 3, forkCount: 2 }], pageInfo: { hasNextPage: true, endCursor: 'next-page' } } },
    { repositories: { nodes: [{ stargazerCount: 4, forkCount: 1 }], pageInfo: { hasNextPage: false, endCursor: 'end' } } },
  ];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ data: { user: responses.shift() } }) };
  };
  const stats = await collectStats('test-secret-not-a-real-token', 'rahoney', fetcher);
  assert.equal(stats.stars, 7);
  assert.equal(stats.forks, 3);
  assert.equal(requests.length, 3);
  for (const { url, options } of requests) {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.match(body.query, /^query /);
    assert.doesNotMatch(body.query, /mutation|nameWithOwner/);
  }
  assert.equal(JSON.parse(requests[2].options.body).variables.after, 'next-page');
  assert.doesNotMatch(JSON.stringify(stats), /test-secret|never-publish/);
});

test('rejects GraphQL partial errors without exposing private error bodies', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ data: { user: {} }, errors: [{ message: 'private-name-and-secret' }] }) });
  await assert.rejects(queryGitHub('secret', 'query Test { viewer { login } }', {}, fetcher), error => {
    assert.doesNotMatch(error.message, /private-name-and-secret/);
    return true;
  });
});

test('rejects authentication errors and invalid usernames before publishing', async () => {
  const fetcher = async () => ({ ok: false, status: 401 });
  await assert.rejects(queryGitHub('secret', 'query Test { viewer { login } }', {}, fetcher), /HTTP 401/);
  await assert.rejects(collectStats('secret', '../bad', fetcher), /username/);
  await assert.rejects(queryGitHub('', 'query Test { viewer { login } }', {}, fetcher), /missing/);
});
