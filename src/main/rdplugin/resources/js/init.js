//= require lib/support

jQuery(function () {
  if (typeof RDPLUGIN != "object") {
    window.RDPLUGIN = {};
  }
  
  // Initialize plugin
  RDPLUGIN["ui-roisummary"] = {
    name: "ui-roisummary"
  };
});