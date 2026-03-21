async function writeCSVToDrive(mergedData, user) {
    console.log(`[${user.id}] Initiating Google Drive write sequence...`);
    
    // Set up authentication options
    let authOptions = { scopes: ['https://www.googleapis.com/auth/drive'] };
    
    // Use the secret if it exists, otherwise fall back to the physical file
    if (process.env.GDRIVE_CREDS) {
        authOptions.credentials = JSON.parse(process.env.GDRIVE_CREDS);
    } else {
        authOptions.keyFile = config.gsheets_key_path;
    }

    const auth = new google.auth.GoogleAuth(authOptions);
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score";
