const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');
const pLimit = require('p-limit').default;

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = 'token.json';
const CACHE_DIR = path.join(__dirname, '.cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
  console.log('Created cache dir:', CACHE_DIR);
} else {
  console.log('Using cache dir:', CACHE_DIR);
}

function authorize(callback) {
  const credentials = JSON.parse(fs.readFileSync('credentials.json'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    callback(oAuth2Client);
  } else {
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('Authorize this app by visiting:', authUrl);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter the code from that page: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code).then(({ tokens }) => {
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        callback(oAuth2Client);
      });
    });
  }
}

function getCachedInboxThreadIds() {
    const path = `${CACHE_DIR}/inbox-thread-ids.json`;
    if (fs.existsSync(path)) {
        try {
            return JSON.parse(fs.readFileSync(path, 'utf8'));
        } catch (e) {
            console.warn('Warning: failed to load inbox thread ID cache. Refetching...');
        }
    }
    return null;
}

function saveCachedInboxThreadIds(ids) {
    const path = `${CACHE_DIR}/inbox-thread-ids.json`;
    fs.writeFileSync(path, JSON.stringify(ids, null, 2));
}
  
function getCachedThread(threadId) {
  const path = `${CACHE_DIR}/thread-${threadId}.json`;
  if (fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  }
  return null;
}

function saveCachedThread(threadId, data) {
    if (!Array.isArray(data.labelIds)) {
        console.warn(`Skipping cache save for ${threadId} — no valid labels.`);
        return;
    }
    const path = `${CACHE_DIR}/thread-${threadId}.json`;
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

/* eventual version
function isStableThread(labels) {
  return labels.includes('=P') || labels.includes('=Q') || labels.includes('=IT');
}
*/
/* test version */
function isStableThread(labelIds) {
    return (labelIds.length > 0);
}
  

async function safeGetThread(gmail, id, retries = 3) {
    try {
        const res = await gmail.users.threads.get({ userId: 'me', id, format: 'minimal' });
        const labelIds = res.data.messages[0].labelIds;
        if (!Array.isArray(labelIds) || labelIds.length === 0) {
            console.warn(`Thread ${id} returned with missing or empty labels.`);
        }
        return res;
    } catch (err) {
        if (retries > 0 && err?.response?.status === 429) {
            const delay = 1000 * (4 - retries);
            console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
            return safeGetThread(gmail, id, retries - 1);
        }
        throw err;
    }
}

async function loadLabelMaps(gmail) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    const labelIdToName = {};
    const labelNameToId = {};
    for (const label of labels) {
        if (label.id && label.name) {
            labelIdToName[label.id] = label.name;
            labelNameToId[label.name] = label.id;
        }
    }
    return { labelIdToName, labelNameToId };
}


async function getInboxThreads(gmail) {
    let threadIds = getCachedInboxThreadIds();
    if (threadIds) {
        console.log(`Loaded ${threadIds.length} inbox thread IDs from cache.`);
        return threadIds.map(id => ({ id }));
    }

    const threads = [];
    let nextPageToken = null;
    do {
        const res = await gmail.users.threads.list({
            userId: 'me', q: 'label:inbox', maxResults: 100, pageToken: nextPageToken
        });
        threads.push(...(res.data.threads || []));
        nextPageToken = res.data.nextPageToken;
        process.stdout.write(`\rFetched ${threads.length} inbox thread IDs...`);
    } while (nextPageToken);

    console.log();
    saveCachedInboxThreadIds(threads.map(t => t.id));
    return threads;
}
  

async function listInboxLabelCounts(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    const { labelIdToName, labelNameToId } = await loadLabelMaps(gmail);
    const threads = await getInboxThreads(gmail);
    
    // Convert the array of thread objects to a Set for fast lookups.
    const inboxThreadIds = new Set(threads.map(t => t.id));

    const labelResults = [];

    // Phase 1: Scan cache
    let validCached = 0;
    let invalidOrMissing = 0;
    const toFetch = [];

    await Promise.all(threads.map(async thread => {
        const threadId = thread.id;
        try {
            const cache = getCachedThread(threadId);
            const labelIds = cache?.labelIds;

            if (Array.isArray(labelIds)) {
                if (!inboxThreadIds.has(threadId)) {
                    fs.unlinkSync(`${CACHE_DIR}/thread-${threadId}.json`);
                } else if (isStableThread(labelIds)) {
                    labelResults.push({ id: threadId, labelIds, fromCache: true });
                    validCached++;
                } else {
                    toFetch.push(threadId);
                }
            } else {
                toFetch.push(threadId);
                invalidOrMissing++;
            }
        } catch (e) {
            toFetch.push(threadId);
            invalidOrMissing++;
        }

        const scanned = validCached + invalidOrMissing;
        process.stdout.write(`\rScanned ${scanned} threads from cache (${validCached} valid, ${invalidOrMissing} invalid)...`);
    }));
    console.log();

    // Phase 2: Fetch missing/unstable threads
    const limit = pLimit(3);
    let fetched = 0;

    await Promise.all(toFetch.map(threadId =>
        limit(async () => {
            const full = await safeGetThread(gmail, threadId);
            const labelIds = full.data.messages[0].labelIds || [];
            
            saveCachedThread(threadId, {
                labelIds: labelIds,
                cachedAt: new Date().toISOString()
            });

            const labelNames = labelIds.map(id => labelIdToName[id]);

            labelResults.push({ id: threadId, labelNames, fromCache: false });
            fetched++;
            process.stdout.write(`\rFetched ${fetched}/${toFetch.length} threads from API...`);
        })
    ));
    console.log();

    // Phase 3: Count labels
    const labelCounts = {};
    let usedCache = 0;
    let usedApi = 0;

    for (const t of labelResults) {
        if (!inboxThreadIds.has(t.id)) continue;
        const labels = t.labelIds || t.labelNames || [];
        for (const label of labels) {
            if (label !== 'INBOX') {
                labelCounts[label] = (labelCounts[label] || 0) + 1;
            }
        }

        if (t.fromCache) usedCache++;
        else usedApi++;
    }

    console.log(`\nUsed ${usedCache} threads from cache, ${usedApi} from API.\n`);

    // Final output
    console.log('Label Name'.padEnd(30) + 'Inbox Threads');
    console.log('='.repeat(40));
    Object.entries(labelCounts)
        .sort(([a], [b]) => {
            const nameA = labelIdToName[a] || '';
            const nameB = labelIdToName[b] || '';
            if (!labelIdToName[a]) console.warn(`Warning: missing label name for ID '${a}'`);
            if (!labelIdToName[b]) console.warn(`Warning: missing label name for ID '${b}'`);
            return nameA.localeCompare(nameB);
        })
        .forEach(([labelId, count]) => {
            const name = labelIdToName[labelId] || `(missing name: ${labelId})`;
            console.log(name.padEnd(30) + count);
        });
    
    const unreadCount = await countThreadsMatchingQuery('in:inbox is:unread', gmail);
    console.log('Inbox unread threads:'.padEnd(30) + unreadCount);

    const untaggedCount = await countThreadsMatchingQuery('in:inbox -label:=it -label:=p -label:=q', gmail);
    console.log('Inbox untagged threads:'.padEnd(30) + untaggedCount);
        
        

}

async function countThreadsMatchingQuery(query, gmail) {
    let count = 0;
    let nextPageToken = null;

    do {
        const res = await gmail.users.threads.list({
            userId: 'me',
            q: query,
            maxResults: 100,
            pageToken: nextPageToken,
        });

        count += res.data.threads?.length || 0;
        nextPageToken = res.data.nextPageToken;
    } while (nextPageToken);

    return count;
}
    

async function countInboxUnreadThreads(gmail) {
    const res = await gmail.users.threads.list({
        userId: 'me',
        q: 'in:inbox is:unread',
    });
    return res.data.resultSizeEstimate || 0;
}


  


authorize(async (auth) => {
  await listInboxLabelCounts(auth);
});
