define(['jquery'], function ($) {

    var initialize = function () {
        document.addEventListener('deviceready', onDeviceReady, false);
    };

    var handleMsg = function (data) {
        var $data = $(data);
        var from = $data.attr('from');
        var msg = $data.find('body').html();
        if (msg) {
            console.log(Strophe.getNodeFromJid(from) + ": " + msg);
            $('.chat').append(Strophe.getNodeFromJid(from) + ": " + msg + "<br />");
        }
        return true;
    };
    var handleRoster = function (data) {
        var $data = $(data);
        if ($data.attr('type') == 'result') {
            $data.find('query > item').each(function (key, value) {
                var $value = $(value);
            })
        } else {
            console.log("type is not result");
        }
        return true;
    };

    var onDeviceReady = function () {
        $('#file').html(cordova.file.applicationDirectory)
        console.log(cordova.file.applicationDirectory);
    };

    return {
        initialize: initialize
    }

});