const elementStyle = {
    position:"absolute", 
    height:{}, 
    width:{}}
const SimpleGrid = React.memo(({style, Tag, elements, selectedFunc, numCols, itemHeight, itemWidth, ...props}) => {
    elementStyle.height = itemHeight
    elementStyle.width = itemWidth
   return <div className="row" style={style}>          
    { elements.map((item, index) => <Tag 
        key={ index }
        index={ index }
        item={ item } 
        isSelected={selectedFunc(item)}
        elementStyle={elementStyle}
        currentRow={(index / numCols )}
        currentColumn={(index % numCols )}
        {...props}
        />)}
    </div>
})
export default SimpleGrid