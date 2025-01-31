function JobListSupport () {
  this.initPage = function (
    firsttab,
    firsttitle,
    contentid,
    tabid,
    tabname,
    tabcontent,
    ontabcontent,
    makefirst,
    newactive
  ) {
    //find main content
    var newtab
    var main = jQuery(firsttab)
    var activeOld = newactive ? '' : 'active'
    var activenew = newactive ? 'active' : ''
    var newTabLi = `<li class="${activenew}"><a href="#${contentid}" data-toggle="tab" id="${tabid}">${tabname}</a></li>`
    if (!main.hasClass('tab-pane')) {
      //add a new tab wrapper
      var tabA = `<li class="${activeOld}"><a href="${firsttab}" data-toggle="tab" id="${firsttab.substr(
        1
      )}_tab">${firsttitle}</a></li>`
      var tabB = newTabLi
      if (makefirst) {
        var c = tabB
        tabB = tabA
        tabA = c
      }
      let tabs = jQuery(`
<div class="vue-tabs">
<div class="nav-tabs-navigation">
<div class="nav-tabs-wrapper">
<ul class="nav nav-tabs">
${tabA}${tabB}
</ul>
</div>
</div>
<div class="tab-content">
<!-- wraps existing content -->
</div>
</div> `)
      newtab = jQuery(
        `<div id="${contentid}" class="tab-pane ${activenew}">${tabcontent}</div>`
      )
      let maintabcontent = tabs.find('.tab-content')
      main.wrap(maintabcontent)
      newtab.insertAfter(main)
      main.addClass('tab-pane ' + activeOld)
      tabs.insertBefore(main.parent())
    } else {
      //update page to add tab
      //find tabs
      let tabs = main.parent().parent().find('.nav.nav-tabs')
      if (tabs.length < 1) {
        let link = jQuery(`[href="${firsttab}"][data-toggle=tab]`)
        if (link) {
          tabs = link.closest('.nav.nav-tabs')
        }
      }
      if (makefirst) {
        tabs.prepend(newTabLi)
      } else {
        tabs.append(newTabLi)
      }
      newtab = jQuery(
        `<div id="${contentid}" class="tab-pane">${tabcontent}</div>`
      )
      newtab.insertAfter(main)
    }
    if (typeof ontabcontent === 'function') {
      ontabcontent(newtab[0])
    }
    return jQuery('#' + tabid)
  }

  function _plugin_message (pluginName, template) {
    var text = template
    var newtemplate = pluginName + '.' + template.replace(/[ =:{}\[\]]/g, '.')
    try {
      text = message(newtemplate)
      if (text === newtemplate) {
        console.log(newtemplate + '=' + template)
      }
    } catch (e) {
      console.log(newtemplate + '=' + template)
    }
    return text
  }

  function _plugin_message_template (
    pluginName,
    template,
    data,
    pluralize,
    templateKey
  ) {
    var text = _plugin_message(pluginName, templateKey || template)
    if (templateKey && text === templateKey) {
      text = template
    }
    return messageTemplate(text, data, pluralize)
  }

  this.i18Message = function (pluginName, code) {
    // console.log('Getting message:', {
    //   pluginName: pluginName,
    //   code: code,
    //   messages: window.Messages
    // })

    let key = pluginName + '.' + code
    let message = window.Messages[key]

    if (!message) {
      console.warn('Message not found:', key)
      return code
    }

    return message
  }

  this.setup_ko_loader = function (prefix, pluginBase, pluginName) {
    // console.log('Setting up ko loader:', {
    //   prefix: prefix,
    //   base: pluginBase,
    //   name: pluginName
    // })
    var pluginUrl = _url_path(pluginBase)
    ko.components.loaders.unshift({
      /**
       * create a config for any component starting with the given prefix
       * @param name
       * @param callback
       */
      getConfig: function (name, callback) {
        if (!name.startsWith(prefix + '-')) {
          callback(null)
          return
        }
        var file = name.substring(prefix.length + 1)
        var fullUrl = pluginUrl + '/html/' + file + '.html'
        callback({
          template: {
            pluginUrl: fullUrl,
            pluginName: pluginName
          }
        })
      },

      /**
       * Load a template given a pluginUrl
       * @param name
       * @param templateConfig
       * @param callback
       */
      loadTemplate: function (name, templateConfig, callback) {
        if (!templateConfig.pluginUrl) {
          // Unrecognized config format. Let another loader handle it.
          callback(null)
          return
        }
        jQuery.get(templateConfig.pluginUrl, function (markupString) {
          markupString = markupString
            .replace(/\$\$([\$\w\.\(\)\+]+)/g, function (match, g1) {
              return '<span data-bind="text: ' + g1 + '"></span>'
            })
            .replace(/%{2}([^<>]+?)%{2}/g, function (match, g1) {
              return (
                '<span data-bind="uijobroilistPluginMessage: \'' +
                (templateConfig.pluginName || 'true') +
                '\'">' +
                g1 +
                '</span>'
              )
            })
          ko.components.defaultLoader.loadTemplate(name, markupString, callback)
        })
      }
    })
    //define component name based on tag name for using custom tags
    var origGetComponentNameForNode = ko.components.getComponentNameForNode
    ko.components.getComponentNameForNode = function (node) {
      var orig = origGetComponentNameForNode(node)
      if (null != orig) {
        return orig
      }
      var tagNameLower = node.tagName && node.tagName.toLowerCase()

      if (tagNameLower.startsWith(prefix + '-')) {
        return tagNameLower
      }
      return null
    }
  }

  function _load_messages_async (pluginName, plugini18nBase, path) {
    return jQuery.ajax({
      url: plugini18nBase + '/' + path + '?format=json',
      success: function (data) {
        if (typeof window.Messages != 'object') {
          window.Messages = {}
        }
        jQuery.extend(window.Messages, data)
      }
    })
  }

  this.init_plugin = function (pluginName, callback) {
    _setup_ko_extenders()
    _load_messages_async(
      pluginName,
      _url_path(rundeckPage.pluginBasei18nUrl(pluginName)),
      'i18n/messages.properties'
    ).then(callback, callback)
  }

  function _url_path (baseUrl) {
    if (baseUrl.indexOf('/') == 0) {
      return baseUrl
    }
    if (baseUrl.toLowerCase().indexOf('http') == 0) {
      var len = baseUrl.indexOf('://')
      if (len > 0) {
        var absurl = baseUrl.substring(len + 3)
        if (absurl.indexOf('/') >= 0) {
          absurl = absurl.substring(absurl.indexOf('/'))
          absurl = absurl.replace(/^\/+/, '/')
          return absurl
        } else {
          return ''
        }
      }
    }
  }

  function _setup_ko_extenders () {
    ko.bindingHandlers.uijobroilistPluginMessage = {
      init: function (
        element,
        valueAccessor,
        allBindings,
        viewModel,
        bindingContext
      ) {
        var text = jQuery(element).text().trim()
        jQuery(element).data('ko-uimessage-template', text)
        return { controlsDescendantBindings: true }
      },
      update: function (
        element,
        valueAccessor,
        allBindings,
        viewModel,
        bindingContext
      ) {
        var pluginName = ko.utils.unwrapObservable(valueAccessor())
        var template = jQuery(element).data('ko-uimessage-template')
        var text = _plugin_message(pluginName, template)
        ko.utils.setTextContent(element, text)
      }
    }
    ko.bindingHandlers.uijobroilistPluginMessageTemplate = {
      init: function (
        element,
        valueAccessor,
        allBindings,
        viewModel,
        bindingContext
      ) {
        var text = jQuery(element).text().trim()
        jQuery(element).data('ko-uimessage-template', text)
        return { controlsDescendantBindings: true }
      },
      update: function (
        element,
        valueAccessor,
        allBindings,
        viewModel,
        bindingContext
      ) {
        var template = jQuery(element).data('ko-uimessage-template')
        var pluralize = allBindings.get('messageTemplatePluralize')
        var pluginName = ko.utils.unwrapObservable(valueAccessor())
        var data = ko.utils.unwrapObservable(allBindings.get('messageArgs'))
        var templateKey = ko.utils.unwrapObservable(
          allBindings.get('messageKey')
        )
        var text = _plugin_message_template(
          pluginName,
          template,
          data,
          pluralize,
          templateKey
        )
        ko.utils.setTextContent(element, text)
      }
    }

    /**
     * Require writes to the value be an integer
     * @param target
     * @returns {void|*}
     */
    ko.extenders.integer = function (target) {
      //create a writable computed observable to intercept writes to our observable
      var result = ko
        .pureComputed({
          read: target, //always return the original observables value
          write: function (newValue) {
            var current = target(),
              newValueAsNum = isNaN(newValue) ? 0 : parseInt(newValue)

            //only write if it changed
            if (newValueAsNum !== current) {
              target(newValueAsNum)
            }
          }
        })
        .extend({ notify: 'always' })

      //initialize with current value to make sure it is rounded appropriately
      result(target())

      //return the new computed observable
      return result
    }
    /**
     * Require writes to the value be an integer, and enforces min/max constraints if present in the value
     * @param target
     * @returns {void|*}
     */
    ko.extenders.intConstraint = function (target, constraint) {
      //create a writable computed observable to intercept writes to our observable
      let result = ko
        .pureComputed({
          read: function () {
            if (
              typeof constraint === 'object' &&
              constraint.min &&
              target() < constraint.min
            ) {
              return constraint.min
            } else if (
              typeof constraint === 'object' &&
              constraint.max &&
              target() > constraint.max
            ) {
              return constraint.max
            } else {
              return target()
            }
          },
          write: function (newValue) {
            let current = target(),
              newValueAsNum = isNaN(newValue) ? 0 : parseInt(newValue),
              override = false
            if (
              typeof constraint === 'object' &&
              constraint.min &&
              newValueAsNum < constraint.min
            ) {
              newValueAsNum = constraint.min
              override = true
            } else if (
              typeof constraint === 'object' &&
              constraint.max &&
              newValueAsNum > constraint.max
            ) {
              newValueAsNum = constraint.max
              override = true
            }
            //only write if it changed
            if (newValueAsNum !== current) {
              target(newValueAsNum)
            } else if (override) {
              target.notifySubscribers(newValueAsNum)
            }
          }
        })
        .extend({ notify: 'always' })

      //initialize with current value to make sure it is rounded appropriately
      result(target())

      //return the new computed observable
      return result
    }
    /**
     * Define a list of allowed values
     * @param target
     * @param values
     * @returns {void|*}
     */
    ko.extenders.inList = function (target, values) {
      var result = ko
        .pureComputed({
          read: target,
          write: function (newValue) {
            var current = target(),
              foundIndex = values.indexOf(newValue)

            //only write if it changed
            if (foundIndex >= 0 && newValue !== current) {
              target(newValue)
            }
          }
        })
        .extend({ notify: 'always' })

      result(target())

      return result
    }
  }
}

function _load_messages_async (pluginName, plugini18nBase, path) {
  // console.log('Loading messages:', {
  //   pluginName: pluginName,
  //   base: plugini18nBase,
  //   path: path
  // })

  return jQuery.ajax({
    url: plugini18nBase + '/' + path + '?format=json',
    success: function (data) {
      //console.log('Loaded messages:', data)
      if (typeof window.Messages != 'object') {
        window.Messages = {}
      }
      jQuery.extend(window.Messages, data)
    },
    error: function (xhr, status, error) {
      console.error('Failed to load messages:', {
        status: status,
        error: error,
        response: xhr.responseText
      })
    }
  })
}
