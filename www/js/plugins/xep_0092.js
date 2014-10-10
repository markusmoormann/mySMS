define(['app/client'], function (client) {
    "use strict";

    var NS = 'jabber:iq:version';

    var handleChatState = function (data) {
        var $data = $(data);
        client.send($iq({
            type: 'result',
            from: $data.attr('to'),
            to: $data.attr('from'),
            id: $data.attr('id')
        })
            .c('query', {xmlns: NS})
            .c('name').t('mySMS').up()
            .c('version').t('version').up()
            .c('os').t('mac OS X'));
        return true;
    };

    var handler = client.addHandler(handleChatState, NS, 'iq');

    return {
        NS: NS
    }
});