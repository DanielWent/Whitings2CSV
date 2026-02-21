// ... existing config code ...

// Define Users with specific folder IDs
config.users = [
    {
        id: "drw",
        height: 1.85,
        token_path: config.output_dir + "drw_tokens.json",
        timestamp_path: config.output_dir + "drw_last_sync.json",
        driveFileName: "drw_withings_bodyscan_data.csv",
        driveFolderId: "1rcyfE_q64FVBQce_FDmAseuayfDs_RzL", // Daniel's Folder
        metricList: "1,6,91,130,155,158,170" 
    },
    {
        id: "aflw",
        height: 1.65, 
        token_path: config.output_dir + "aflw_tokens.json",
        timestamp_path: config.output_dir + "aflw_last_sync.json",
        driveFileName: "aflw_withings_bodyscan_data.csv",
        driveFolderId: "1qOmgohljP-vLVzsyPNver0Ky6neQg0vW", // April's Folder
        metricList: "1,6,91,130,155,158,170"
    }
];

// ... rest of file ...
