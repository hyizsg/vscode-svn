local user_name = ""
local svnMsg = "配置表patch"
if arg[2] then
    user_name = arg[2]
end
if arg[3] then
    svnMsg = arg[3]
end
local fixStartStr = "--[[\n"..svnMsg.."\nby "..user_name.."\nstart\n]]\n"
local fixEndStr = "--[[\n"..svnMsg.."\nby "..user_name.."\nend\n]]\n"
local dataDir = arg[1]
local projectDir = string.format("%s/../..", dataDir)
-- 添加搜索路径，避免像monster_info_abyss这样的表中require取不到文件
package.path = string.format("?.lua;%s/?.lua", projectDir)

local function isEmpty( t )
	for k,v in pairs(t) do
		return false
	end
	return true
end


local function vardump(object, label)
    local lookupTable = {}
    local result = {}

    local function _v(v)
        if type(v) == "string" then
            v = "[[" .. v .. "]]"
        elseif type(v) == "number" then
            if v % 1 == 0 then
                return string.format("%0.18g", v)
            end
            return string.format("%f", v)
        end
        return tostring(v)
    end

    local function _vardump(object, label, indent, nest)
        label = label or "<var>"
        local postfix = ""
        if nest > 1 then postfix = "," end
        if type(object) ~= "table" then
            if type(label) == "string" then
                result[#result +1] = string.format("%s[\"%s\"] = %s%s", indent, label, _v(object), postfix)
            elseif type(label) == "number" then
                result[#result +1] = string.format("%s[%s] = %s%s", indent, label, _v(object), postfix)
            else
                result[#result +1] = string.format("%s%s%s", indent, _v(object), postfix)
            end
        elseif not lookupTable[object] then
            lookupTable[object] = true

            if type(label) == "string" then
                result[#result +1 ] = string.format("%s%s = {", indent, label)
            else
                result[#result +1 ] = string.format("%s[%s] = {", indent, label)
            end
            local indent2 = indent .. "    "
            local keys = {}
            local values = {}
            for k, v in pairs(object) do
                keys[#keys + 1] = k
                values[k] = v
            end
            table.sort(keys, function(a, b)
                if type(a) == "number" and type(b) == "number" then
                    return a < b
                else
                    return tostring(a) < tostring(b)
                end
            end)
            for i, k in ipairs(keys) do
                _vardump(values[k], k, indent2, nest + 1)
            end
            result[#result +1] = string.format("%s}%s", indent, postfix)
        end
    end
    _vardump(object, label, "", 1)

    return table.concat(result, "\n")
end

------------------------------------------------
local fileList = {}
for i = 4, #arg do
    fileList[#fileList + 1] = arg[i]
end

local function startGen(fileName)

    local old = require("old."..fileName)
    local new = require("new."..fileName)

    local newList = new["list"] or new
    local newIndexMap = new["index_map"] or {}
    if not newList or not newIndexMap then return "" end

    local oldList = old["list"] or old
    local oldIndexMap = old["index_map"] or {}

    local patchList = {}
    local patchIndex = {}
    local delList = {}
    local delIndex = {}

    if #newList >= #oldList then
        for i=1,#newList do
            local arrNew = newList[i]
            local arrOld = oldList[i]
            if type(arrNew) == "table" then 
                for j=1,#arrNew do
                    if arrOld == nil or arrNew[j] ~= arrOld[j] then
                        if patchList[i] == nil then
                            patchList[i] = {}
                        end
                        patchList[i][j] = arrNew[j]
                    end
                end
            end
        end

        for k,v in pairs(newIndexMap) do
            if oldIndexMap[k] ~= v then
                patchIndex[k] = v
            end
        end
    else
        for i=1,#oldList do
            local arrNew = newList[i]
            local arrOld = oldList[i]
            if arrNew == nil then
                if delList[i] then
                    delList[i] = {}
                end
                delList[i] = i
            else
                if type(arrNew) == "table" then 
                    for j=1,#arrNew do
                        if arrNew[j] ~= arrOld[j] then
                            if patchList[i] == nil then
                                patchList[i] = {}
                            end
                            patchList[i][j] = arrNew[j]
                        end
                    end
                end
            end
        end

        for k,v in pairs(oldIndexMap) do
            if newIndexMap[k] and newIndexMap[k] ~= v then
                patchIndex[k] = newIndexMap[k]
            elseif newIndexMap[k] == nil then
                delIndex[k] = k
            end
        end
    end

    -- index_map 的分表
    local isIndexMap = false
    if isEmpty(patchIndex) and string.find(fileName, "_index_map_") then
        isIndexMap = true
        for k, v in pairs(newList) do
            if oldList[k] ~= v then
                patchIndex[k] = v
            end
        end

        for k, v in pairs(oldList) do
            if newList[k] == nil then
                delIndex[k] = k
            end
        end
    end

    local str = ""
    -- 不分表或者分表的主表
    if new["keys"] ~= nil then
        str = str .. [[
global.cfgMgr._cacheData["#file_name#"] = nil
]]
    end


    if isIndexMap then
        str = str .. [[
local #file_name# = require("res.data.#file_name#")
local index_map = #file_name#
]]
    else
        if next(patchList) == nil then
            if next(newIndexMap) == nil then
                str = str .. [[
local #file_name# = require("res.data.#file_name#")
local list = #file_name#
]]
            else
                str = str .. [[
local #file_name# = require("res.data.#file_name#")
local list = #file_name#["list"]
local index_map = #file_name#["index_map"]
]]
            end
        else
            if next(newIndexMap) == nil then
                str = str .. [[
local #file_name# = require("res.data.#file_name#")
local list = #file_name#
]]
            else
                str = str .. [[
local #file_name# = require("res.data.#file_name#")
local list = #file_name#["list"]
local index_map = #file_name#["index_map"]
]]
            end
        end
    end
    local strList,strIndex,strDelList,strDelIndex
    -- str = string.gsub(str,"#file_name#",fileName)
    --更新数据
    local hasListUpdate = not isEmpty(patchList)
    local hasIndexUpdate = not isEmpty(patchIndex)

    if hasListUpdate then
        strList = vardump(patchList,"","")
        local strUpdate = [[
local list_update#strList#
for k,v in pairs(list_update) do
    list[k] = list[k] or {}
    for kk,vv in pairs(v) do
       list[k][kk] = vv
    end
end
]]
        str = str..strUpdate
        strList = string.gsub(strList,"%%","%%%%")
        str = string.gsub(str,"#strList#",strList)
    end

    if hasIndexUpdate then
        strIndex = vardump(patchIndex,"","")
    	local strUpdate = [[
local index_update#strIndex#
for k,v in pairs(index_update) do
	index_map[k] = index_update[k]
end
]]
        str = str..strUpdate
        -- strIndex = string.gsub(strIndex,"%%","%%%%")
        str = string.gsub(str,"#strIndex#",strIndex)
    end

    ---删除数据
    local hasDel = not isEmpty(delList) or not isEmpty(delIndex)
    if hasDel then
        strDelList = vardump(delList,"","")
        strDelIndex = vardump(delIndex,"","")    
        local strDel = [[
local list_del#strDelList#
local index_del#strDelIndex#
for k,v in pairs(list_del) do
    list[k] = nil
end
for k,v in pairs(index_del) do
    index_map[k] = nil
end
]]
        str = str..strDel
        str = string.gsub(str,"#strDelList#",strDelList)
        str = string.gsub(str,"#strDelIndex#",strDelIndex)
    end
    
    local hasUpdate = new["list_length"] ~= old["list_length"]
    if hasUpdate then
        local listLengthStr = [[
#file_name#["list_length"] = #list_length#
]]
        listLengthStr = string.gsub(listLengthStr,"#list_length#",new["list_length"])
        str = str .. listLengthStr
    end

    if hasUpdate or hasListUpdate or hasIndexUpdate or hasDel then
        str = str 
        str = string.gsub(str,"#file_name#",fileName)
        return str
    else
        return ""
    end
end


local file = io.open("patch.lua","w+")
local strPatch = ""
strPatch = strPatch..fixStartStr
for i=1,#fileList do
    local fileName = string.gsub(fileList[i],".lua","")
    strPatch = strPatch..startGen(fileName)
    if i < #fileList then
        strPatch = strPatch.."\n--------------------------------------------------\n"        
    end
end
strPatch = strPatch..fixEndStr
file:write(strPatch)
file:close()
print("success ====================== ")