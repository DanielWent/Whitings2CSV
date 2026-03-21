var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp(user) {
    try {
        let timestamp = fs.readFileSync(user.timestamp_path, 'utf8');
        console.log(`[${user.id}] Read previous timestamp: ${timestamp}`);
        return JSON.parse(timestamp);
    } catch (err) {
        console.warn(`[${user.id}] Could not read timestamp file. Defaulting to 0. Reason: ${err.message}`);
        return 0; 
    } 
}

async function getReplacementAccessToken(refreshToken, user) {
    console.log(`[${user.id}] Attempting to refresh Withings Access Token...`);
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);

    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { 
            headers: { ...bodyFormData.getHeaders() } 
        });

        if (response.data.body && response.data.body.access_token) {
            console.log(`[${user.id}] Token successfully refreshed.`);
            storeTokens(response.data.body.access_token, response.data.body.refresh_token, user);
            return response.data.body.access_token;
        } else {
            console.error(`[${user.id}] Token refresh response lacked access_token. Full response:`, JSON.stringify(response.data));
        }
    } catch (error) { 
        console.error(`[${user.id}] Token Refresh HTTP Error:`, error.message);
        if (error.response) console.error(`[${user.id}] Error Response Data:`, JSON.stringify(error.response.data));
    }
    return null;
}

function storeTokens(accessToken, refreshToken, user) {
    try { 
        fs.writeFileSync(user.token_path, JSON.stringify({ accessToken, refreshToken })); 
        console.log(`[${user.id}] Tokens saved to disk.`);
    } catch (error) { 
        console.error(`[${user.id}] Error storing tokens:`, error.message); 
    }
}

function storeTime(latestTimestamp, user) {
    try { 
        fs.writeFileSync(user.timestamp_path, JSON.stringify(latestTimestamp)); 
        console.log(`[${user.id}] Timestamp ${latestTimestamp} saved to disk.`);
    } catch (error) { 
        console.error(`[${user.id}] Error storing timestamp:`, error.message); 
    }
}

async function getWithingsData(accessToken, refreshToken, currentTime, user) {
    const startdate = Math.max(0, getPreviousTimestamp(user) - 432000);
    console.log(`[${user.id}] Fetching data from startdate: ${startdate} to enddate: ${currentTime}`);
    
    let allMeasureGrps = [];
    let hasMore = true;
    let currentOffset = 0;

    try {
        while (hasMore) {
            console.log(`[${user.id}] Requesting /measure API... (Offset: ${currentOffset})`);
            var bodyFormData = new FormData();
            bodyFormData.append('action', 'getmeas');
            bodyFormData.append('access_token', accessToken);
            bodyFormData.append('startdate', startdate);
            bodyFormData.append('enddate', currentTime);
            
            if (currentOffset !== 0) {
                bodyFormData.append('offset', currentOffset);
            }
            
            const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { 
                headers: { ...bodyFormData.getHeaders() } 
            });
            
            console.log(`[${user.id}] Withings API Status Code: ${response.data.status}`);
            
            if (response.data.status === 401) {
                console.warn(`[${user.id}] Token expired (401). Initiating refresh sequence...`);
                let newAccessToken = await getReplacementAccessToken(refreshToken, user);
                if (newAccessToken) {
                    return await getWithingsData(newAccessToken, refreshToken, currentTime, user);
                } else {
                    console.error(`[${user.id}] Failed to get replacement token. Aborting sync for this user.`);
                    return null;
                }
            } else if (response.data.status === 0) {
                if (response.data.body.measuregrps) {
                    console.log(`[${user.id}] Retrieved ${response.data.body.measuregrps.length} measure groups.`);
                    allMeasureGrps = allMeasureGrps.concat(response.data.body.measuregrps);
                } else {
                    console.log(`[${user.id}] No measure groups in body.`);
                }
                
                if (response.data.body.more && response.data.body.offset) {
                    currentOffset = response.data.body.offset;
                    console.log(`[${user.id}] More data available. Setting offset to ${currentOffset}.`);
                } else {
                    console.log(`[${user.id}] No more pages to fetch.`);
                    hasMore = false;
                }
            } else {
                console.error(`[${user.id}] Unhandled API Status Error: ${response.data.status}. Response: ${JSON.stringify(response.data)}`);
                hasMore = false;
            }
        }

        if (allMeasureGrps.length > 0) {
            console.log(`[${user.id}] Total measure groups to process: ${allMeasureGrps.length}`);
            let combinedBody = { measuregrps: allMeasureGrps };
            let mergedData = await processData(combinedBody, user);
            await persistData(mergedData, user);
            await storeTime(currentTime, user);
            return combinedBody;
        } else {
            console.log(`[${user.id}] No new measurements found in timeframe. Updating timestamp.`);
            await storeTime(currentTime, user);
            return null;
        }

    } catch (error) { 
        console.error(`[${user.id}] Fatal Catch in getWithingsData:`, error.message);
        if (error.response) console.error(`[${user.id}] Axios Error Response:`, error.response.data);
        return null; 
    }
}

async function processData(scaleData, user) {
    console.log(`[${user.id}] Formatting and merging raw metrics...`);
    let dataByDate = new Map();

    if (scaleData && scaleData.measuregrps) {
        scaleData.measuregrps.forEach(grp => {
            let timestamp = grp.date;
            let existingTimestamp = Array.from(dataByDate.keys()).find(t => Math.abs(t - timestamp) <= 3600);
            let targetKey = existingTimestamp || timestamp;

            if (!dataByDate.has(targetKey)) dataByDate.set(targetKey, { date: targetKey });
            let entry = dataByDate.get(targetKey);

            grp.measures.forEach(measure => {
                let val = measure.value * Math.pow(10, measure.unit);
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    if (metricName === "Body Fat (%)" && user.id === 'drw') {
                        val = val + 3;
                    }
                    if (metricName === "AFib Status") {
                        if (val === 9) val = "Sinus Rhythm (No Signs of AFib)";
                        else if (val === 10) val = "High Heart Rate (No Signs of AFib)";
                        else if (val === 5) val = "Poor Recording";
                        else if (val === 2) val = "Inconclusive";    
                        else val = `Unclassified (${val})`;
                    }
                    if (entry[metricName] === undefined) entry[metricName] = val;
                    if (metricName === "Weight (kg)" && user.height) {
                        entry["BMI"] = val / (user.height * user.height);
                    }
                }
            });
        });
    }
    
    let processedArray = Array.from(dataByDate.values()).sort((a, b) => b.date - a.date);
    console.log(`[${user.id}] Processing complete. Yielded ${processedArray.length} unique daily records.`);
    return processedArray;
}

function formatRow(item) {
    let d = new Date(item.date * 1000);
    let dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
    const getVal = (key, decimals = null) => {
        let val = item[key];
        if (val === undefined || val === null || val === "") return "";
        if (typeof val === 'number' && decimals !== null) return val.toFixed(decimals);
        return val;
    };
    return [
        dateStr,
        getVal("Weight (kg)", 2),
        getVal("BMI", 1),
        getVal("Body Fat (%)", 2),
        getVal("Visceral Fat Rating", 1),
        getVal("Pulse Wave Velocity (m/s)", 2),
        getVal("AFib Status"),
        getVal("Vascular Age (years)", 1),
        getVal("Nerve Health Score", 1)
    ].join(",");
}

function finalValidator(allRowsMap) {
    let approvedRows = [];
    let sortedDates = Array.from(allRowsMap.keys()).sort((a, b) => new Date(b) - new Date(a));
    sortedDates.forEach(dateKey => {
        let row = allRowsMap.get(dateKey);
        let columns = row.split(',');
        let weightValue = columns[1] ? columns[1].trim() : "";
        if (weightValue !== "" && !isNaN(parseFloat(weightValue))) {
            approvedRows.push(row);
        }
    });
    return approvedRows;
}

async function writeCSVToDrive(mergedData, user) {
    console.log(`[${user.id}] Initiating Google Drive write sequence...`);
    
    let authOptions = { scopes: ['https://www.googleapis.com/auth/drive'] };
    
    if (process.env.GDRIVE_CREDS) {
        authOptions.credentials = JSON.parse(process.env.GDRIVE_CREDS);
    } else {
        authOptions.keyFile = config.gsheets_key_path;
    }

    const auth = new google.auth.GoogleAuth(authOptions);
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score";
    let fileId = null, fileContent = "";

    try {
        console.log(`[${user.id}] Searching for file '${user.driveFileName}' in folder '${user.driveFolderId}'`);
        const listRes = await drive.files.list({ 
            q: `'${user.driveFolderId}' in parents and name = '${user.driveFileName}' and trashed = false` 
        });

        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            console.log(`[${user.id}] Found existing file. ID: ${fileId}. Downloading current content...`);
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = getRes.data;
            console.log(`[${user.id}] Successfully downloaded existing file content.`);
        } else {
            console.log(`[${user.id}] File not found in Drive. Will create a new one.`);
        }

        let allRowsMap = new Map();
        if (fileContent && typeof fileContent === 'string') {
            fileContent.split(/\r?\n/).forEach(line => {
                let trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("date,")) {
                    allRowsMap.set(trimmed.split(',')[0], trimmed);
                }
            });
        }
        console.log(`[${user.id}] Loaded ${allRowsMap.size} existing rows into memory.`);

        mergedData.forEach(item => {
            let row = formatRow(item);
            allRowsMap.set(row.split(',')[0], row);
        });

        let scrubbedRows = finalValidator(allRowsMap);
        let fullCSV = headerRow + "\n" + scrubbedRows.join("\n") + "\n";
        console.log(`[${user.id}] Preparing to upload final CSV containing ${scrubbedRows.length} rows.`);

        if (fileId) {
            await drive.files.update({ 
                fileId, 
                media: { mimeType: 'text/csv', body: fullCSV } 
            });
            console.log(`[${user.id}] SUCCESS: Updated existing Drive CSV.`);
        } else {
            await drive.files.create({ 
                requestBody: { name: user.driveFileName, parents: [user.driveFolderId] }, 
                media: { mimeType: 'text/csv', body: fullCSV } 
            });
            console.log(`[${user.id}] SUCCESS: Created new Drive CSV.`);
        }
    } catch (error) { 
        console.error(`[${user.id}] FATAL Drive Error:`, error.message); 
    }
}

async function persistData(mergedData, user) {
    await writeCSVToDrive(mergedData, user);
}

module.exports = { 
    getPreviousTimestamp, 
    getReplacementAccessToken, 
    storeTokens, 
    storeTime, 
    getWithingsData, 
    processData, 
    persistData 
};
