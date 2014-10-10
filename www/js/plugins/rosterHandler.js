define(['app/client', 'jquery'], function (client, $) {

    var handleRoster = function (data) {
        var $data = $(data);
        if ($data.attr('type') == 'result') {
            $data.find('query > item').each(function (key, value) {
                var $value = $(value);
                console.log($value);
            })
        } else {
            console.log("type is not result");
        }
        return true;
    };

    client.addHandler(handleRoster, Strophe.NS.ROSTER, 'iq');
});