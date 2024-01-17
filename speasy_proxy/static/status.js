async function update_status() {
    const current_url = window.location.href;
    $.ajax({
        url: current_url + 'get_server_status',
        type: 'GET',
        dataType: 'json',
        success: function (data) {
            console.log(data);
            var status_container = $('body').find("ul#status-container.container");
            status_container.find("li.version").html('version: ' + data.version);
            status_container.find("li.inventory-last-update").html('Last inventory update: ' + data.last_inventory_update);
            status_container.find("li.speasy-version").html('Speasy version: ' + data.speasy_version);
            status_container.find("li.up-since").html('up since: ' + data.up_since);
            status_container.find("li.cache-entries").html('Entries in cache: ' + numeral(data.entries).format('0 a'));
            status_container.find("li.uptime").html('up for: ' + numeral(data.up_duration).format('0,0') + ' seconds');
            status_container.find("li.cache-size").html('cache size: ' + numeral(data.cache_disk_size).format('0.00b'));
        }
    });
}
