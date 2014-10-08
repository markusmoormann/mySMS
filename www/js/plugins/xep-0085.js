var XEP_0085 = function () {
    "use strict";

    var NS = 'http://jabber.org/protocol/chatstates';

    var handleChatState = function (data) {
        var $data = $(data);
        var chatStateElement = $data.find('[xmlns="' + NS + '"]');
        var chatstate = chatStateElement.prop('tagName');
        console.log(chatstate)
        return true;
    };


    return {
        handleChatState: handleChatState,
        NS: NS
    }
}();