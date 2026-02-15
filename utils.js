var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { 
        console.log("No previous timestamp found, starting from 0.");
        return 0; 
    }
}

async function getReplacementAccessToken(refreshToken) {
    console.log("Attempting to refresh Withings tokens...");
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);
    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        if (response.data.body && response.data.body.access_token) {
            console.log("Tokens refreshed successfully.");
            storeTokens(response.data.body.access_token, response.data.body.refresh_token);
        } else {
            console.log("Failed to refresh tokens:", JSON.stringify(response.data));
        }
    } catch (error) { console.log("Error during token refresh:", error.message); }
}

function storeTokens(accessToken, refreshToken) {
    try { fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error saving token file:", error); }
}

function storeTime(latestTimestamp) {
    try { fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error saving timestamp file:", error) }
}

async function processData(scaleData) {
    console.log("Processing Withings API response...");
    let simplifiedData = [];
    if (scaleData.measuregrps && scaleData.measuregrps.length > 0) {
        console.log(`Received ${scaleData.measuregrps.length} measurement groups.`);
        for (var i = 0; i < scaleData.measuregrps.length; i++) {
            for (var j = 0; j < scaleData.measuregrps[i].measures.length; j++) {
                let singleEntry = { date: scaleData.measuregrps[i].date };
                let metric = config.metrics[scaleData.measuregrps[i].measures[j].type];
                if(metric) {
                    singleEntry[metric] = scaleData.measuregrps[i].measures[j].value;
                    simplifiedData.push(singleEntry);
                }
            }
        }
    } else {
        console.log("No measurement groups found in Withings response.");
    }

    // Merge measurements sharing the same date
    var mergedMap = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});

    // FIX: Convert Object back to Array so .length works in the next step
    const mergedArray = Object.values(mergedMap);
    console.log(`Processed into ${mergedArray.length} unique daily records.`);
    return mergedArray;
}

async function writeCSVToDrive(mergedData) {
    console.log(`Starting Drive Sync for ${mergedData.length} records...`);
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "sep=,\ndate,Weight,Body Fat %,Heart Pulse,Pulse Wave Velocity (m/s),ECG,Vascular Age,Nerve Health Score\n";
    let fileId = null;
    let fileContent = "";

    try {
        console.log(`Searching for file '${config.driveFileName}' in folder '${config.driveFolderId}'...`);
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, fields: 'files(id, name)' });
        
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            console.log(`Found existing file ID: ${fileId}. Downloading content...`);
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
            if (!fileContent) fileContent = headerRow;
        } else { 
            console.log("No existing file found. Will create a new one.");
            fileContent = headerRow; 
        }

        const existingLines = fileContent.split("\n").map(line => line.split(','));
        let newContent = "";
        let duplicateCount = 0;

        for (var k = mergedData.length - 1; k >= 0; k--) {
            var matched = existingLines.some(line => line[0] == mergedData[k].date);
            if (!matched) {
                newContent += `${mergedData[k].date},${mergedData[k]["Weight"]||""},${mergedData[k]["Body Fat %"]||""},${mergedData[k]["Heart Pulse"]||""},${mergedData[k]["Pulse Wave Velocity (m/s)"]||""},${mergedData[k]["ECG"]||""},${mergedData[k]["Vascular Age"]||""},${mergedData[k]["Nerve Health Score"]||""}\n`;
            } else {
                duplicateCount++;
            }
        }

        console.log(`Checked ${mergedData.length} items: ${duplicateCount} were duplicates, ${newContent.split('\n').length - 1} are new.`);

        if (newContent.length > 0 || !fileId) {
            const body = (fileId ? fileContent : "") + newContent;
            if (fileId) {
                console.log("Updating existing file in Google Drive...");
                await drive.files.update({ fileId, media: { mimeType: 'text/csv', body } });
            } else {
                console.log("Creating new file in Google Drive...");
                await drive.files.create({ resource: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: (headerRow + newContent) } });
            }
            console.log("Drive upload complete.");
        } else {
            console.log("No new data to write. Skipping Drive update.");
        }
    } catch (e) { console.log("Drive Error Detailed:", e.message); }
}

async function persistData(mergedData) {
    console.log("Scaling and formatting data...");
    for (var i = 0; i < mergedData.length; i++) {
        if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = (mergedData[i]["Weight"] / 1000).toFixed(2);
        if (mergedData[i]["Body Fat %"]) mergedData[i]["Body Fat %"] = (mergedData[i]["Body Fat %"] / 1000).toFixed(2);
        if (mergedData[i]["Pulse Wave Velocity (m/s)"]) mergedData[i]["Pulse Wave Velocity (m/s)"] = (mergedData[i]["Pulse Wave Velocity (m/s)"] / 1000).toFixed(2);
        if (mergedData[i]["Nerve Health Score"]) mergedData[i]["Nerve Health Score"] = (mergedData[i]["Nerve Health Score"] / 1000).toFixed(1);

        let d = new Date(mergedData[i].date * 1000);
        mergedData[i].date = `${d.getFullYear()}-${("0"+(d.getMonth()+1)).slice(-2)}-${("0"+d.getDate()).slice(-2)} ${("0"+d.getHours()).slice(-2)}:${("0"+d.getMinutes()).slice(-2)}:${("0"+d.getSeconds()).slice(-2)}`;
    }
    await writeCSVToDrive(mergedData);
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    // RESTORED: Plural 'meastypes' is the correct API parameter
    bodyFormData.append('meastypes', config.metricList);
    bodyFormData.append('startdate', getPreviousTimestamp() + 1);
    bodyFormData.append('enddate', currentTime);

    console.log(`Requesting metrics [${config.metricList}] since timestamp ${getPreviousTimestamp()}...`);
    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders(), Authorization: 'Bearer ' + accessToken } });
        
        if (response.data.status == 0) {
            console.log("Withings API request successful.");
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) {
            console.log("Withings session expired (401). Attempting refresh.");
            await getReplacementAccessToken(refreshToken);
        } else {
            console.log(`Withings API returned error status: ${response.data.status}. Full response:`, JSON.stringify(response.data));
        }
    } catch (error) { console.log("Critical Error in Withings request:", error.message); }
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, persistData, processData };
