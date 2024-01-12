async function update_status() {
    const current_url = window.location.href;
    $.ajax({
        url: current_url+'get_statistics',
        type: 'GET',
        dataType: 'json',
        success: function (data) {
            console.log(data);
            var status_container = $('body').find("ul#status-container.container");
            status_container.find("li.version").html('version: ' + data.version);
            status_container.find("li.up-since").html('up since: ' + data.up_since);
            status_container.find("li.cache-entries").html('Entries in cache: ' + numeral(data.entries).format('0 a'));
            status_container.find("li.uptime").html('up for: ' + numeral(data.up_duration).format('0,0') + ' seconds');
            status_container.find("li.cache-hits").html('cache hits: ' + data.cache_hits);
            status_container.find("li.cache-misses").html('cache misses: ' + data.cache_misses);
            status_container.find("li.cache-size").html('cache size: ' + numeral(data.cache_disk_size).format('0.00b'));
        }
    });
}
